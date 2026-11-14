// Integration tests for the seal routes, against a local fake OpenTimestamps calendar.
//   POST /seals · PUT /seals/:id · POST /seals/:id/upgrade · GET /seals · DELETE /seals/:id
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { chunkSets, seals, users } from "../../src/db/schema";
import { runGc } from "../../src/gc";
import { __clearBlockHeaderCache } from "../../src/services/block-source";
import { nowSec } from "../../src/lib/time";
import { recomputeUserQuota } from "../../src/services/quota-service";
import { createSeededFileItem, createTestUser, db, resetDb } from "../helpers";

// A real calendar reply captured for the client's parser tests; here it is only opaque bytes.
const FIXTURES = resolve(import.meta.dir, "../../../client/src/lib/modules/seal/__fixtures__");
const PENDING_REPLY = new Uint8Array(readFileSync(`${FIXTURES}/calendar-alice.pending.bin`));

type FakeCalendar = {
    url: string;
    /** What the calendar does with the next requests. */
    mode: "ok" | "down" | "huge";
    upgrade: "pending" | "confirmed";
    seen: Array<{ method: string; path: string; body: Uint8Array }>;
    stop: () => void;
};

function startCalendar(): FakeCalendar {
    const cal: FakeCalendar = {
        url: "",
        mode: "ok",
        upgrade: "pending",
        seen: [],
        stop: () => {},
    };
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const path = new URL(req.url).pathname;
            cal.seen.push({
                method: req.method,
                path,
                body: new Uint8Array(await req.arrayBuffer()),
            });
            if (cal.mode === "down") return new Response("unavailable", { status: 503 });
            if (cal.mode === "huge") return new Response(new Uint8Array(65 * 1024));
            if (req.method === "POST" && path === "/digest") return new Response(PENDING_REPLY);
            if (req.method === "GET" && path.startsWith("/timestamp/")) {
                return cal.upgrade === "pending"
                    ? new Response("Pending confirmation in Bitcoin blockchain", { status: 404 })
                    : new Response(new Uint8Array([0x00, 1, 2, 3, 4, 5, 6, 7, 8, 1, 0]));
            }
            return new Response("not found", { status: 404 });
        },
    });
    cal.url = `http://127.0.0.1:${server.port}`;
    cal.stop = () => server.stop(true);
    return cal;
}

let app: FastifyInstance;
let cookie: string;
let email: string;
let calA: FakeCalendar;
let calB: FakeCalendar;
const envBefore = { ...process.env };

beforeAll(async () => {
    calA = startCalendar();
    calB = startCalendar();
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
    calA.stop();
    calB.stop();
});

beforeEach(async () => {
    await resetDb();
    ({ cookie, email } = await createTestUser(app));
    process.env.OTS_CALENDAR_URLS = `${calA.url},${calB.url}`;
    process.env.SEALS_PER_DAY = "3";
    for (const c of [calA, calB]) {
        c.mode = "ok";
        c.upgrade = "pending";
        c.seen = [];
    }
});

afterEach(() => {
    for (const k of ["OTS_CALENDAR_URLS", "SEALS_PER_DAY"]) {
        if (envBefore[k] === undefined) delete process.env[k];
        else process.env[k] = envBefore[k];
    }
});

const COMMITMENT = "79668695e5fe189f67f318cdcb5f010f36b2cfd704b4833b5ad1d6daf08decbd";

async function fileChunkSet(): Promise<string> {
    return (await createSeededFileItem(app, cookie, email, 64)).chunkSetId;
}

function createSeal(chunkSetId: string, id = uuidv7(), as = cookie) {
    return app.inject({
        method: "POST",
        url: "/seals",
        headers: { cookie: as },
        payload: { id, chunk_set_id: chunkSetId, commitment: COMMITMENT },
    });
}

const RECORD = {
    state: "pending",
    encrypted_record: Buffer.alloc(300, 1).toString("base64"),
    record_nonce: "A".repeat(32),
    encrypted_seal_key: "C".repeat(64),
    seal_key_nonce: "B".repeat(32),
};
const RECORD_BYTES = 300 + 24 + 48 + 24;

async function usedItems(): Promise<number> {
    const [row] = await db
        .select({ v: users.storage_used_items })
        .from(users)
        .where(eq(users.email, email));
    return row?.v ?? 0;
}

describe("POST /seals", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({ method: "POST", url: "/seals", payload: {} });
        expect(res.statusCode).toBe(401);
    });

    test("relays the commitment to every calendar and returns their replies", async () => {
        const id = uuidv7();
        const res = await createSeal(await fileChunkSet(), id);
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.id).toBe(id);
        expect(body.replies).toHaveLength(2);
        for (const r of body.replies) {
            expect(r.ok).toBe(true);
            expect(Buffer.from(r.body, "base64").equals(Buffer.from(PENDING_REPLY))).toBe(true);
        }
        for (const c of [calA, calB]) {
            expect(c.seen).toHaveLength(1);
            expect(c.seen[0]?.path).toBe("/digest");
            expect(Buffer.from(c.seen[0]!.body).toString("hex")).toBe(COMMITMENT);
        }
        const [row] = await db.select().from(seals).where(eq(seals.id, id));
        expect(row?.state).toBe("pending");
        expect(row?.encrypted_record).toBeNull();
    });

    test("one calendar down is fine; its reply is marked as failed", async () => {
        calB.mode = "down";
        const res = await createSeal(await fileChunkSet());
        expect(res.statusCode).toBe(201);
        expect(
            res
                .json()
                .replies.map((r: { ok: boolean }) => r.ok)
                .sort(),
        ).toEqual([false, true]);
    });

    test("AC3: all calendars down → 502, no row, and the daily allowance is not spent", async () => {
        calA.mode = "down";
        calB.mode = "huge";
        const set = await fileChunkSet();
        const res = await createSeal(set);
        expect(res.statusCode).toBe(502);
        expect(res.json().error).toBe("calendars_unavailable");
        expect(await db.select().from(seals)).toHaveLength(0);
        const list = await app.inject({ method: "GET", url: "/seals", headers: { cookie } });
        expect(list.json().limit).toEqual({ per_day: 3, used_today: 0 });
    });

    test("AC4: the seal over the daily allowance is refused with the limit from the server", async () => {
        const set = await fileChunkSet();
        for (let i = 0; i < 3; i++) expect((await createSeal(set)).statusCode).toBe(201);
        const res = await createSeal(set);
        expect(res.statusCode).toBe(429);
        expect(res.json()).toEqual({ error: "seal_limit", limit: 3 });
        expect(calA.seen).toHaveLength(3);
    });

    test("AC5: another user's chunk set → 404, the same answer as a missing one", async () => {
        const otherSet = await fileChunkSet();
        const other = await createTestUser(app, { email: "other@example.com" });
        const foreign = await createSeal(otherSet, uuidv7(), other.cookie);
        const missing = await createSeal(uuidv7(), uuidv7(), other.cookie);
        expect(foreign.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
        expect(foreign.body).toBe(missing.body);
        expect(calA.seen).toHaveLength(0);
    });

    test("a chunk set already marked for deletion cannot be sealed", async () => {
        const set = await fileChunkSet();
        await db
            .update(chunkSets)
            .set({ pending_delete_at: nowSec() })
            .where(eq(chunkSets.id, set));
        expect((await createSeal(set)).statusCode).toBe(404);
    });

    test("AC8: an empty calendar list turns sealing off without an error elsewhere", async () => {
        process.env.OTS_CALENDAR_URLS = "";
        const res = await createSeal(await fileChunkSet());
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("seals_disabled");
        const cfg = await app.inject({ method: "GET", url: "/instance-config" });
        expect(cfg.statusCode).toBe(200);
        expect(cfg.json().sealsEnabled).toBeUndefined();
        process.env.OTS_CALENDAR_URLS = calA.url;
        const on = await app.inject({ method: "GET", url: "/instance-config" });
        expect(on.json().sealsEnabled).toBe(true);
    });

    test("a reused id → 409", async () => {
        const set = await fileChunkSet();
        const id = uuidv7();
        expect((await createSeal(set, id)).statusCode).toBe(201);
        expect((await createSeal(set, id)).statusCode).toBe(409);
    });
});

describe("PUT /seals/:id", () => {
    test("stores the encrypted record and charges its bytes to the items bucket", async () => {
        const id = uuidv7();
        await createSeal(await fileChunkSet(), id);
        const before = await usedItems();
        const res = await app.inject({
            method: "PUT",
            url: `/seals/${id}`,
            headers: { cookie },
            payload: RECORD,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().encrypted_record).toBe(RECORD.encrypted_record);
        expect((await usedItems()) - before).toBe(RECORD_BYTES);

        // The rebuild from the rows agrees with the incremental count.
        const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
        const rebuilt = await recomputeUserQuota(db, u!.id);
        expect(rebuilt.items).toBe(await usedItems());
    });

    test("confirmed never goes back to pending", async () => {
        const id = uuidv7();
        await createSeal(await fileChunkSet(), id);
        const put = (state: string) =>
            app.inject({
                method: "PUT",
                url: `/seals/${id}`,
                headers: { cookie },
                payload: { ...RECORD, state },
            });
        expect((await put("confirmed")).statusCode).toBe(200);
        expect((await put("pending")).statusCode).toBe(409);
    });

    test("someone else's seal → 404", async () => {
        const id = uuidv7();
        await createSeal(await fileChunkSet(), id);
        const other = await createTestUser(app, { email: "other@example.com" });
        const res = await app.inject({
            method: "PUT",
            url: `/seals/${id}`,
            headers: { cookie: other.cookie },
            payload: RECORD,
        });
        expect(res.statusCode).toBe(404);
    });
});

describe("POST /seals/:id/upgrade", () => {
    async function upgrade(id: string, attestations: Array<{ calendar: string; message: string }>) {
        return app.inject({
            method: "POST",
            url: `/seals/${id}/upgrade`,
            headers: { cookie },
            payload: { attestations },
        });
    }

    test("pending is an ordinary answer; a calendar off the list is never contacted", async () => {
        const id = uuidv7();
        await createSeal(await fileChunkSet(), id);
        for (const c of [calA, calB]) c.seen = [];
        const res = await upgrade(id, [
            { calendar: calA.url, message: "ab".repeat(44) },
            { calendar: "http://169.254.169.254", message: "cd".repeat(44) },
        ]);
        expect(res.statusCode).toBe(200);
        expect(res.json().results.map((r: { status: string }) => r.status)).toEqual([
            "pending",
            "skipped",
        ]);
        expect(calA.seen.map((s) => s.path)).toEqual([`/timestamp/${"ab".repeat(44)}`]);
    });

    test("a completed timestamp comes back as base64 bytes", async () => {
        const id = uuidv7();
        await createSeal(await fileChunkSet(), id);
        calB.upgrade = "confirmed";
        const res = await upgrade(id, [{ calendar: `${calB.url}/`, message: "ef".repeat(44) }]);
        const [r] = res.json().results;
        expect(r.status).toBe("confirmed");
        expect(Buffer.from(r.body, "base64").length).toBe(11);
    });

    test("an unknown seal → 404, before any calendar is asked", async () => {
        const res = await upgrade(uuidv7(), [{ calendar: calA.url, message: "ab".repeat(44) }]);
        expect(res.statusCode).toBe(404);
        expect(calA.seen).toHaveLength(0);
    });
});

describe("GET and DELETE", () => {
    test("lists the user's seals with today's allowance; delete gives the quota back", async () => {
        const id = uuidv7();
        await createSeal(await fileChunkSet(), id);
        await app.inject({
            method: "PUT",
            url: `/seals/${id}`,
            headers: { cookie },
            payload: RECORD,
        });
        const list = await app.inject({ method: "GET", url: "/seals", headers: { cookie } });
        expect(list.json().seals.map((s: { id: string }) => s.id)).toEqual([id]);
        expect(list.json().limit).toEqual({ per_day: 3, used_today: 1 });

        const before = await usedItems();
        const del = await app.inject({
            method: "DELETE",
            url: `/seals/${id}`,
            headers: { cookie },
        });
        expect(del.statusCode).toBe(204);
        expect(before - (await usedItems())).toBe(RECORD_BYTES);
        const again = await app.inject({
            method: "DELETE",
            url: `/seals/${id}`,
            headers: { cookie },
        });
        expect(again.statusCode).toBe(404);
    });
});

describe("GET /seals/blocks/:height", () => {
    const HEADER = readFileSync(`${FIXTURES}/block-975723.header.hex`, "utf8").trim();
    const HASH = "00".repeat(32);
    let explorer: { url: string; seen: string[]; stop: () => void };

    beforeAll(() => {
        const seen: string[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(req) {
                const path = new URL(req.url).pathname;
                seen.push(path);
                if (path === "/block-height/975723") return new Response(HASH);
                if (path === `/block/${HASH}/header`) return new Response(HEADER);
                return new Response("not found", { status: 404 });
            },
        });
        explorer = { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
    });
    afterAll(() => explorer.stop());
    beforeEach(() => {
        __clearBlockHeaderCache();
        explorer.seen.length = 0;
        process.env.OTS_BLOCK_SOURCE_URL = explorer.url;
    });
    afterEach(() => {
        if (envBefore.OTS_BLOCK_SOURCE_URL === undefined) delete process.env.OTS_BLOCK_SOURCE_URL;
        else process.env.OTS_BLOCK_SOURCE_URL = envBefore.OTS_BLOCK_SOURCE_URL;
    });

    const get = (height: string, as = cookie) =>
        app.inject({ method: "GET", url: `/seals/blocks/${height}`, headers: { cookie: as } });

    test("relays the header and serves it from cache the second time", async () => {
        const res = await get("975723");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ height: 975723, header: HEADER });
        await get("975723");
        expect(explorer.seen).toEqual(["/block-height/975723", `/block/${HASH}/header`]);
    });

    test("without a session → 401; a bad height → 400; an unknown block → 502", async () => {
        expect((await app.inject({ method: "GET", url: "/seals/blocks/1" })).statusCode).toBe(401);
        expect((await get("-1")).statusCode).toBe(400);
        expect((await get("1e3")).statusCode).toBe(400);
        expect((await get("99999999999")).statusCode).toBe(400);
        expect((await get("1")).statusCode).toBe(502);
    });

    test("an empty OTS_BLOCK_SOURCE_URL turns it off", async () => {
        process.env.OTS_BLOCK_SOURCE_URL = "";
        const res = await get("975723");
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("block_source_disabled");
        expect(explorer.seen).toEqual([]);
    });
});

describe("AC9: the commitment is never stored or logged", () => {
    const src = (rel: string) => readFileSync(resolve(import.meta.dir, "../../src", rel), "utf8");

    test("no column of the seals table carries it", () => {
        expect(Object.keys(seals)).not.toContain("commitment");
        expect(src("db/schema.ts")).not.toMatch(/text\("commitment"\)|bytea\("commitment"\)/);
    });

    test("the seal route and the calendar client log nothing at all", () => {
        for (const file of [
            "routes/seals.ts",
            "services/ots-calendar.ts",
            "services/seal-service.ts",
            "services/block-source.ts",
        ]) {
            expect(src(file)).not.toMatch(/\b(log|logger)\.(trace|debug|info|warn|error|fatal)\(/);
            expect(src(file)).not.toMatch(/console\./);
        }
    });

    // The client treats any 403 outside /auth as a locked account and signs the user out, so a
    // seal route must never use it for "off" or "not allowed".
    test("no seal route answers 403", () => {
        expect(src("routes/seals.ts")).not.toMatch(/status\(403\)/);
    });
});

describe("AC11: a seal lives exactly as long as its chunk set", () => {
    test("GC deletes the seal with the purged chunk set and returns its quota", async () => {
        const set = await fileChunkSet();
        const id = uuidv7();
        await createSeal(set, id);
        await app.inject({
            method: "PUT",
            url: `/seals/${id}`,
            headers: { cookie },
            payload: RECORD,
        });
        const before = await usedItems();

        // Still within the grace window (a crop can be undone): the seal stays.
        await db
            .update(chunkSets)
            .set({ pending_delete_at: nowSec() })
            .where(eq(chunkSets.id, set));
        await runGc({ now: nowSec(), blobPurgeGrace: 3600, staleUploadSeconds: 3600 });
        expect(await db.select().from(seals)).toHaveLength(1);

        await runGc({ now: nowSec() + 7200, blobPurgeGrace: 3600, staleUploadSeconds: 3600 });
        expect(await db.select().from(seals)).toHaveLength(0);
        expect(before - (await usedItems())).toBe(RECORD_BYTES);
    });
});
