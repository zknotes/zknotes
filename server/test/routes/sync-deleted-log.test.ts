// Integration tests for sync_deleted_log:
//   - every hard-delete path writes a row into the log
//     (DELETE /items/:id/purge, POST /items/batch delete_ids)
//   - GET /items?since= returns the `deleted` list past the watermark (delta pull, the second list)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { items } from "../../src/db/schema";
import {
    createSeededFileItem,
    createTestUser,
    db,
    getChunkSetPendingDeleteAt,
    getDeletedLogEntries,
    getUserIdByEmail,
    getUserStorageUsed,
    notePayload,
    resetDb,
} from "../helpers";

const FILE_SIZE = 64;

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

// ── Local helpers ────────────────────────────────────────────────────────────

async function createNote(as = cookie): Promise<string> {
    const id = uuidv7();
    const res = await app.inject({
        method: "POST",
        url: "/items",
        headers: { cookie: as },
        payload: notePayload(id),
    });
    expect(res.statusCode).toBe(201);
    return id;
}

/** A seeded chunk set plus a file item (the upload flow is not what these tests are about, see helpers). */
async function createFileItem(): Promise<{ itemId: string; chunkSetId: string }> {
    return createSeededFileItem(app, cookie, userEmail, FILE_SIZE);
}

async function trashItem(itemId: string, as = cookie) {
    const res = await app.inject({
        method: "DELETE",
        url: `/items/${itemId}`,
        headers: { cookie: as },
    });
    expect(res.statusCode).toBe(200);
}

async function pull(since: number, as = cookie) {
    const res = await app.inject({
        method: "GET",
        url: `/items?since=${since}&limit=1000`,
        headers: { cookie: as },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
        items: any[];
        deleted: { id: string; deleted_at: number }[];
        server_time: number;
    };
}

// ── The hard-delete paths write to the log ───────────────────────────────────

describe("sync_deleted_log — the write on a hard delete", () => {
    test("DELETE /items/:id/purge writes a row into the log", async () => {
        const { itemId } = await createFileItem();
        await trashItem(itemId);

        const res = await app.inject({
            method: "DELETE",
            url: `/items/${itemId}/purge`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);

        const entries = await getDeletedLogEntries(itemId);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.user_id).toBe((await getUserIdByEmail(userEmail))!);
        expect(entries[0]?.deleted_at).toBeGreaterThan(0);
    });

    test("a double purge is idempotent — still exactly one log row", async () => {
        const { itemId } = await createFileItem();
        await trashItem(itemId);

        await app.inject({ method: "DELETE", url: `/items/${itemId}/purge`, headers: { cookie } });
        await app.inject({ method: "DELETE", url: `/items/${itemId}/purge`, headers: { cookie } });

        expect(await getDeletedLogEntries(itemId)).toHaveLength(1);
    });

    test("a soft delete (DELETE /items/:id) does NOT write to the log — trash is not a hard delete", async () => {
        const noteId = await createNote();
        await trashItem(noteId);

        expect(await getDeletedLogEntries(noteId)).toHaveLength(0);
    });
});

// ── batch delete_ids = a hard delete (purge semantics) ───────────────────────

describe("POST /items/batch delete_ids — purge semantics", () => {
    test("a note: purged_at set and a log row written", async () => {
        const noteId = await createNote();

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [noteId] },
        });
        expect(res.statusCode).toBe(200);

        const [row] = await db.select().from(items).where(eq(items.id, noteId)).limit(1);
        expect(row?.deleted_at).toBeGreaterThan(0);
        expect(row?.purged_at).toBeGreaterThan(0);
        expect(row?.encrypted_payload).toBeNull();

        expect(await getDeletedLogEntries(noteId)).toHaveLength(1);
    });

    test("file: blob → pending_delete, the quota released, a log row written", async () => {
        const { itemId, chunkSetId } = await createFileItem();
        expect(await getUserStorageUsed(userEmail)).toBe(FILE_SIZE);

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [itemId] },
        });
        expect(res.statusCode).toBe(200);

        const [row] = await db.select().from(items).where(eq(items.id, itemId)).limit(1);
        expect(row?.purged_at).toBeGreaterThan(0);
        expect(row?.chunk_set_id).toBeNull();

        expect(await getChunkSetPendingDeleteAt(chunkSetId)).toBeGreaterThan(0);
        expect(await getUserStorageUsed(userEmail)).toBe(0);
        expect(await getDeletedLogEntries(itemId)).toHaveLength(1);
    });

    test("idempotent: repeated delete_ids for an already-purged item do not duplicate the log", async () => {
        const noteId = await createNote();
        const payload = { upsert: [], delete_ids: [noteId] };

        await app.inject({ method: "POST", url: "/items/batch", headers: { cookie }, payload });
        await app.inject({ method: "POST", url: "/items/batch", headers: { cookie }, payload });

        expect(await getDeletedLogEntries(noteId)).toHaveLength(1);
    });
});

// ── The delta pull returns the deleted list ──────────────────────────────────

describe("GET /items?since= — the deleted list (delta pull)", () => {
    test("since=0 returns every log entry", async () => {
        const noteId = await createNote();
        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [noteId] },
        });

        const data = await pull(0);
        expect(data.deleted).toHaveLength(1);
        expect(data.deleted[0]?.id).toBe(noteId);
        expect(data.deleted[0]?.deleted_at).toBeGreaterThan(0);
    });

    test("a deletion past the watermark is returned; one before it is not", async () => {
        const noteId = await createNote();

        // The watermark BEFORE the deletion (server_time is in ms)
        const before = await pull(0);

        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [noteId] },
        });

        // A pull with a watermark from before the deletion → the deletion is visible
        const delta = await pull(before.server_time - 5000);
        expect(delta.deleted.some((d) => d.id === noteId)).toBe(true);

        // A pull with a watermark long after the deletion → empty
        const later = await pull(Date.now() + 60_000);
        expect(later.deleted).toHaveLength(0);
    });

    test("the deleted list still works once the items tombstone is physically gone (GC sweep)", async () => {
        const noteId = await createNote();
        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [noteId] },
        });

        // Simulate GC: remove the items tombstone — the signal has to survive in the log
        await db.delete(items).where(eq(items.id, noteId));

        const data = await pull(0);
        expect(data.items.find((i) => i.id === noteId)).toBeUndefined();
        expect(data.deleted.some((d) => d.id === noteId)).toBe(true);
    });

    test("user isolation — other people's deletions are not in the deleted list", async () => {
        const noteId = await createNote();
        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [noteId] },
        });

        const { cookie: otherCookie } = await createTestUser(app, { email: "other@example.com" });
        const data = await pull(0, otherCookie);
        expect(data.deleted).toHaveLength(0);
    });
});
