/**
 * The GET /items watermark: the clock before the query plus the safety window.
 */
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    spyOn,
    test,
} from "bun:test";
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

afterEach(() => {
    delete process.env.SYNC_WATERMARK_SAFETY_MS;
});

async function pull(since?: number) {
    const url = since === undefined ? "/items?limit=1000" : `/items?since=${since}&limit=1000`;
    const res = await app.inject({ method: "GET", url, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return res.json() as {
        items: { id: string; updated_at: number }[];
        deleted: { id: string; deleted_at: number }[];
        server_time: number;
        server_time_iso: string;
    };
}

describe("GET /items watermark", () => {
    test("server_time lags behind the real time by roughly the safety window", async () => {
        process.env.SYNC_WATERMARK_SAFETY_MS = "2000";
        const t0 = Date.now();
        const body = await pull();
        const t1 = Date.now();
        // The request's duration (auth plus two SELECTs) is the tolerance, not part of the window.
        expect(body.server_time).toBeGreaterThanOrEqual(t0 - 2000 - 500);
        expect(body.server_time).toBeLessThanOrEqual(t1 - 2000 + 500);
        expect(new Date(body.server_time_iso).getTime()).toBe(body.server_time);
    });

    test("the clock is captured before the first SELECT in the handler", async () => {
        process.env.SYNC_WATERMARK_SAFETY_MS = "5000";
        const itemsSelectAt: number[] = [];
        const originalSelect = db.select.bind(db) as typeof db.select;
        const passthrough = originalSelect as (...args: unknown[]) => ReturnType<typeof db.select>;
        const spy = spyOn(db, "select").mockImplementation(((...args: unknown[]) => {
            // authenticate runs db.select({...}) with its own fields; the handler's listing starts
            // with the keyset-and-size select (`wireBytes`), then loads full rows (no arguments).
            const fields = args[0] as Record<string, unknown> | undefined;
            if (args.length === 0 || (fields !== undefined && "wireBytes" in fields)) {
                itemsSelectAt.push(Date.now());
            }
            return passthrough(...args);
        }) as typeof db.select);

        try {
            const body = await pull();
            expect(itemsSelectAt.length).toBeGreaterThan(0);
            const firstHandlerSelect = itemsSelectAt[0]!;
            expect(body.server_time + 5000).toBeLessThanOrEqual(firstHandlerSelect);
        } finally {
            spy.mockRestore();
        }
    });

    test("a long transaction does not lose rows", async () => {
        process.env.SYNC_WATERMARK_SAFETY_MS = "5000";
        const userId = await getUserIdByEmail(userEmail);
        if (!userId) throw new Error("missing user");
        const itemId = uuidv7();
        const stampedAt = Math.floor(Date.now() / 1000);

        let releaseHold = () => {};
        const hold = new Promise<void>((resolve) => {
            releaseHold = resolve;
        });
        let inserted = () => {};
        const insertedP = new Promise<void>((resolve) => {
            inserted = resolve;
        });

        const txPromise = db.transaction(async (tx) => {
            await tx.insert(items).values({
                id: itemId,
                user_id: userId,
                type: "note",
                sort_order: "m",
                version: 1,
                created_at: stampedAt,
                updated_at: stampedAt,
            });
            inserted();
            await hold;
        });

        try {
            await insertedP;
            // The watermark is issued more than 1 s after the stamp, while the row is still uncommitted.
            await new Promise((r) => setTimeout(r, 1100));
            const during = await pull();
            expect(during.items.some((it) => it.id === itemId)).toBe(false);

            releaseHold();
            await txPromise;

            const delta = await pull(during.server_time);
            expect(delta.items.some((it) => it.id === itemId)).toBe(true);
        } finally {
            releaseHold();
            await txPromise.catch(() => {});
        }
    }, 15_000);

    test("a record committed after the snapshot enters the next pull", async () => {
        const first = await pull();
        const id = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        expect(created.statusCode).toBe(201);
        expect(first.items.some((it) => it.id === id)).toBe(false);

        const second = await pull(first.server_time);
        expect(second.items.some((it) => it.id === id)).toBe(true);
    });

    test("inclusivity: an item with updated_at == floor(since/1000) is in the response", async () => {
        const id = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        expect(created.statusCode).toBe(201);
        const updatedAt = created.json().updated_at as number;
        const body = await pull(updatedAt * 1000);
        expect(body.items.some((it) => it.id === id)).toBe(true);
    });

    test("deleted[] follows the same watermark (inclusive)", async () => {
        const userId = await getUserIdByEmail(userEmail);
        if (!userId) throw new Error("missing user");
        const itemId = uuidv7();
        const deletedAt = Math.floor(Date.now() / 1000) - 10;
        await insertDeletedLogEntry(userId, itemId, deletedAt);

        const body = await pull(deletedAt * 1000);
        expect(body.deleted.some((d) => d.id === itemId && d.deleted_at === deletedAt)).toBe(true);
    });

    test("since=0 is a full sync (items plus the whole sync_deleted_log)", async () => {
        const id = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        expect(created.statusCode).toBe(201);

        const userId = await getUserIdByEmail(userEmail);
        if (!userId) throw new Error("missing user");
        const deletedId = uuidv7();
        await insertDeletedLogEntry(userId, deletedId, Math.floor(Date.now() / 1000));

        const body = await pull(0);
        expect(body.items.some((it) => it.id === id)).toBe(true);
        expect(body.deleted.some((d) => d.id === deletedId)).toBe(true);
    });
});
