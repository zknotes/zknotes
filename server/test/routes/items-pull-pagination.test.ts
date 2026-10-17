/**
 * GET /items pagination: `limit` is required, the keyset cursor, identical updated_at values, a
 * bounded deleted list, and a corrupt cursor → 400.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SYNC_LIMITS, decodePullCursor, encodePullCursor } from "@zknotes/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { items } from "../../src/db/schema";
import {
    createTestUser,
    getUserIdByEmail,
    insertDeletedLogEntry,
    notePayload,
    resetDb,
} from "../helpers";

let app: FastifyInstance;
let cookie: string;
let userEmail: string;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    await resetDb();
    ({ cookie, email: userEmail } = await createTestUser(app));
});

type PullBody = {
    items: { id: string; updated_at: number }[];
    deleted: { id: string; deleted_at: number }[];
    server_time: number;
    server_time_iso: string;
    next_cursor?: string | null;
};

async function pull(qs: string) {
    const res = await app.inject({
        method: "GET",
        url: `/items${qs}`,
        headers: { cookie },
    });
    return { status: res.statusCode, body: res.json() as PullBody };
}

async function createNotes(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const id = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        expect(res.statusCode).toBe(201);
        ids.push(id);
    }
    return ids;
}

describe("GET /items pagination", () => {
    // Without `limit` the route used to build the whole of a user's items and deletion log in
    // memory, with no bound. Every client pages, so the unbounded form is gone.
    test("without a limit the pull is refused — there is no unbounded form", async () => {
        await createNotes(3);
        for (const qs of ["", "?since=0", "?since=1700000000"]) {
            const { status, body } = await pull(qs);
            expect(status).toBe(400);
            expect(body).toEqual({ error: "invalid_input" } as unknown as PullBody);
        }
    });

    test("one page that holds everything ends with next_cursor null", async () => {
        const ids = await createNotes(3);
        const { status, body } = await pull("?since=0&limit=10");
        expect(status).toBe(200);
        expect(body.next_cursor).toBeNull();
        expect(body.items.map((i) => i.id).sort()).toEqual([...ids].sort());
        expect(body.deleted).toEqual([]);
        expect(body.server_time).toBeGreaterThan(0);
    });

    test("paging across the boundary: limit=2 over 5 items, a next_cursor and then null", async () => {
        const ids = await createNotes(5);
        const seen: string[] = [];
        let cursor: string | null | undefined;
        let pages = 0;
        let firstServerTime: number | undefined;
        do {
            const qs =
                cursor == null
                    ? `?since=0&limit=2`
                    : `?since=0&limit=2&cursor=${encodeURIComponent(cursor)}`;
            const { status, body } = await pull(qs);
            expect(status).toBe(200);
            expect(body.items.length).toBeLessThanOrEqual(2);
            if (firstServerTime === undefined) firstServerTime = body.server_time;
            else expect(body.server_time).toBe(firstServerTime);
            seen.push(...body.items.map((i) => i.id));
            cursor = body.next_cursor ?? null;
            pages += 1;
        } while (cursor);
        expect(pages).toBeGreaterThan(1);
        expect(seen.sort()).toEqual([...ids].sort());
        expect(new Set(seen).size).toBe(ids.length);
    });

    test("a broken cursor → 400, not a silent pull from zero", async () => {
        await createNotes(2);
        const bad = await pull("?since=0&limit=2&cursor=not-a-valid-cursor");
        expect(bad.status).toBe(400);
        expect((bad.body as { error?: string }).error).toBe("invalid_cursor");

        const tsOnly = Buffer.from(
            JSON.stringify({
                v: 1,
                st: 1,
                it: 1_700_000_000,
                idone: false,
                ddone: true,
            }),
        ).toString("base64url");
        const naive = await pull(`?since=0&limit=2&cursor=${tsOnly}`);
        expect(naive.status).toBe(400);
        expect((naive.body as { error?: string }).error).toBe("invalid_cursor");
    });

    test("a cursor without a limit → 400, like any pull without one", async () => {
        const encoded = encodePullCursor({
            v: 1,
            st: 1,
            it: 1,
            iid: uuidv7(),
            idone: false,
            ddone: true,
        });
        const { status, body } = await pull(`?since=0&cursor=${encodeURIComponent(encoded)}`);
        expect(status).toBe(400);
        expect((body as { error?: string }).error).toBe("invalid_input");
    });

    test("the deleted list is bounded by the limit", async () => {
        const userId = await getUserIdByEmail(userEmail);
        expect(userId).toBeDefined();
        const deletedAt = Math.floor(Date.now() / 1000);
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = uuidv7();
            ids.push(id);
            await insertDeletedLogEntry(userId!, id, deletedAt);
        }
        const seen: string[] = [];
        let cursor: string | null | undefined;
        do {
            const qs =
                cursor == null
                    ? `?since=0&limit=2`
                    : `?since=0&limit=2&cursor=${encodeURIComponent(cursor)}`;
            const { status, body } = await pull(qs);
            expect(status).toBe(200);
            expect(body.deleted.length).toBeLessThanOrEqual(2);
            seen.push(...body.deleted.map((d) => d.id));
            cursor = body.next_cursor ?? null;
        } while (cursor);
        expect(seen.sort()).toEqual([...ids].sort());
        expect(new Set(seen).size).toBe(5);
    });

    test("a row modified between pages still arrives within this sequence", async () => {
        const ids = await createNotes(3);
        const first = await pull("?since=0&limit=1");
        expect(first.status).toBe(200);
        expect(first.body.next_cursor).toBeTruthy();
        const remaining = ids.filter((id) => id !== first.body.items[0]?.id);
        const bumped = remaining[0]!;
        await db
            .update(items)
            .set({ updated_at: Math.floor(Date.now() / 1000) + 60 })
            .where(eq(items.id, bumped));
        const seen = new Set(first.body.items.map((i) => i.id));
        let cursor = first.body.next_cursor ?? null;
        while (cursor) {
            const page = await pull(`?since=0&limit=1&cursor=${encodeURIComponent(cursor)}`);
            expect(page.status).toBe(200);
            for (const it of page.body.items) seen.add(it.id);
            cursor = page.body.next_cursor ?? null;
        }
        expect(seen.has(bumped)).toBe(true);
        expect(seen.size).toBe(ids.length);
    });
});

describe("GET /items pagination — large payloads", () => {
    // Each payload is ~4 MiB of base64, so only one fits in the 8 MiB page budget. The page used to
    // load `limit + 1` full rows before cutting; it now loads only what fits, and the cursor still
    // walks every row exactly once.
    test("pages stay within the byte budget and still return every row once", async () => {
        const big = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64");
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const id = uuidv7();
            const res = await app.inject({
                method: "POST",
                url: "/items",
                headers: { cookie },
                payload: notePayload(id, { encrypted_payload: big }),
            });
            expect(res.statusCode).toBe(201);
            ids.push(id);
        }

        const seen: string[] = [];
        let cursor: string | null | undefined;
        let pages = 0;
        do {
            const qs =
                cursor == null
                    ? "?since=0&limit=1000"
                    : `?since=0&limit=1000&cursor=${encodeURIComponent(cursor)}`;
            const res = await app.inject({
                method: "GET",
                url: `/items${qs}`,
                headers: { cookie },
            });
            expect(res.statusCode).toBe(200);
            expect(res.rawPayload.length).toBeLessThanOrEqual(SYNC_LIMITS.PULL_PAGE_BYTES);
            const body = res.json() as PullBody;
            expect(body.items.length).toBe(1);
            seen.push(...body.items.map((i) => i.id));
            cursor = body.next_cursor ?? null;
            pages += 1;
        } while (cursor && pages < 10);
        expect(seen.sort()).toEqual([...ids].sort());
    });
});

describe("GET /items pagination — identical updated_at", () => {
    test(
        "100,000 rows with an identical updated_at are returned exactly once",
        async () => {
            const userId = await getUserIdByEmail(userEmail);
            expect(userId).toBeDefined();
            const N = 100_000;
            const ts = 1_700_003_000;
            const payload = Buffer.alloc(8, 7);
            const nonce = Buffer.alloc(24, 3);
            const ikey = Buffer.alloc(48, 5);
            const allIds: string[] = [];
            const CHUNK = 2000;
            for (let i = 0; i < N; i += CHUNK) {
                const slice = [];
                const end = Math.min(N, i + CHUNK);
                for (let j = i; j < end; j++) {
                    const id = uuidv7();
                    allIds.push(id);
                    slice.push({
                        id,
                        user_id: userId!,
                        type: "note" as const,
                        parent_id: null,
                        encrypted_payload: payload,
                        payload_nonce: nonce,
                        encrypted_item_key: ikey,
                        item_key_nonce: nonce,
                        version: 1,
                        sort_order: "a0",
                        created_at: ts,
                        updated_at: ts,
                    });
                }
                await db.insert(items).values(slice);
            }

            const seen = new Set<string>();
            let cursor: string | null | undefined;
            let pages = 0;
            const t0 = Date.now();
            do {
                const qs =
                    cursor == null
                        ? `?since=0&limit=${SYNC_LIMITS.PULL_PAGE_SIZE}`
                        : `?since=0&limit=${SYNC_LIMITS.PULL_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`;
                const { status, body } = await pull(qs);
                expect(status).toBe(200);
                expect(body.items.length).toBeLessThanOrEqual(SYNC_LIMITS.PULL_PAGE_SIZE);
                const pageJson = JSON.stringify(body);
                expect(pageJson.length).toBeLessThanOrEqual(SYNC_LIMITS.PULL_PAGE_BYTES);
                for (const it of body.items) {
                    expect(seen.has(it.id)).toBe(false);
                    seen.add(it.id);
                }
                if (body.next_cursor) {
                    const decoded = decodePullCursor(body.next_cursor);
                    expect(decoded?.iid).toBeDefined();
                    expect(decoded?.st).toBe(body.server_time);
                }
                cursor = body.next_cursor ?? null;
                pages += 1;
            } while (cursor);

            expect(seen.size).toBe(N);
            expect(pages).toBe(Math.ceil(N / SYNC_LIMITS.PULL_PAGE_SIZE));
            expect(Date.now() - t0).toBeLessThan(180_000);
            expect(allIds.every((id) => seen.has(id))).toBe(true);
        },
        { timeout: 180_000 },
    );
});
