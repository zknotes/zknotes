// Integration tests for the purge endpoint:
//   DELETE /items/:id/purge  — a hard-delete of one TRASHED item
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { itemHistory, items } from "../../src/db/schema";
import {
    createSeededFileItem,
    createTestUser,
    db,
    getChunkSetPendingDeleteAt,
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

/** A seeded chunk set plus a file item (the upload flow is not what these tests are about, see helpers). */
async function createFileItem(): Promise<{ itemId: string; chunkSetId: string }> {
    return createSeededFileItem(app, cookie, userEmail, FILE_SIZE);
}

/** Soft-delete (trash) an item via DELETE /items/:id. */
async function trashItem(itemId: string, as = cookie) {
    const res = await app.inject({
        method: "DELETE",
        url: `/items/${itemId}`,
        headers: { cookie: as },
    });
    expect(res.statusCode).toBe(200);
}

/** Fetches an item row straight from the database. */
async function getItem(id: string) {
    const [row] = await db.select().from(items).where(eq(items.id, id)).limit(1);
    return row;
}

// ── DELETE /items/:id/purge ───────────────────────────────────────────────────

describe("DELETE /items/:id/purge", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({ method: "DELETE", url: `/items/${uuidv7()}/purge` });
        expect(res.statusCode).toBe(401);
    });

    test("a non-existent item → 404", async () => {
        const res = await app.inject({
            method: "DELETE",
            url: `/items/${uuidv7()}/purge`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(404);
    });

    test("a live item (not trashed) → 409", async () => {
        const { itemId } = await createFileItem();
        const res = await app.inject({
            method: "DELETE",
            url: `/items/${itemId}/purge`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("Item must be trashed before purge");
    });

    test("a trashed file → 200, purged_at is set, chunk_set_id is nulled", async () => {
        const { itemId } = await createFileItem();
        await trashItem(itemId);

        const res = await app.inject({
            method: "DELETE",
            url: `/items/${itemId}/purge`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);

        const row = await getItem(itemId);
        expect(row).toBeDefined();
        expect(row?.purged_at).toBeGreaterThan(0);
        expect(row?.chunk_set_id).toBeNull();
        // The encrypted blocks were nulled
        expect(row?.encrypted_payload).toBeNull();
        expect(row?.encrypted_item_key).toBeNull();
        expect(row?.payload_nonce).toBeNull();
        expect(row?.item_key_nonce).toBeNull();
        // The tombstone attributes stay
        expect(row?.deleted_at).toBeGreaterThan(0);
        expect(row?.id).toBe(itemId);
    });

    test("the version increments on purge", async () => {
        const { itemId } = await createFileItem();
        const beforeTrash = await getItem(itemId);
        await trashItem(itemId); // version → 2

        await app.inject({ method: "DELETE", url: `/items/${itemId}/purge`, headers: { cookie } });

        const afterPurge = await getItem(itemId);
        expect(afterPurge?.version).toBe((beforeTrash?.version ?? 1) + 2); // +1 trash, +1 purge
    });

    test("the chunk set is marked pending_delete after a purge", async () => {
        const { itemId, chunkSetId } = await createFileItem();
        await trashItem(itemId);

        await app.inject({ method: "DELETE", url: `/items/${itemId}/purge`, headers: { cookie } });

        const pendingAt = await getChunkSetPendingDeleteAt(chunkSetId);
        expect(pendingAt).toBeGreaterThan(0);
    });

    test("purge lowers storage_used_files", async () => {
        const { itemId } = await createFileItem();

        expect(await getUserStorageUsed(userEmail)).toBe(FILE_SIZE);

        await trashItem(itemId);
        await app.inject({ method: "DELETE", url: `/items/${itemId}/purge`, headers: { cookie } });

        expect(await getUserStorageUsed(userEmail)).toBe(0);
    });

    test("idempotent: purging twice → 200 both times, and storage_used_files never goes negative", async () => {
        const { itemId } = await createFileItem();
        await trashItem(itemId);

        const first = await app.inject({
            method: "DELETE",
            url: `/items/${itemId}/purge`,
            headers: { cookie },
        });
        expect(first.statusCode).toBe(200);

        const second = await app.inject({
            method: "DELETE",
            url: `/items/${itemId}/purge`,
            headers: { cookie },
        });
        expect(second.statusCode).toBe(200);

        // storage_used_files must never fall below 0
        expect(await getUserStorageUsed(userEmail)).toBe(0);
    });

    test("another user's item → 404 (user isolation)", async () => {
        const { itemId } = await createFileItem();
        await trashItem(itemId);

        const { cookie: otherCookie } = await createTestUser(app, { email: "other@example.com" });
        const res = await app.inject({
            method: "DELETE",
            url: `/items/${itemId}/purge`,
            headers: { cookie: otherCookie },
        });
        expect(res.statusCode).toBe(404);
    });

    test("a trashed note (with no chunk set) → 200, purged_at set", async () => {
        const noteId = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(noteId),
        });
        await trashItem(noteId);

        const res = await app.inject({
            method: "DELETE",
            url: `/items/${noteId}/purge`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);

        const row = await getItem(noteId);
        expect(row?.purged_at).toBeGreaterThan(0);
        expect(row?.chunk_set_id).toBeNull();
    });

    // Regression: the purge refunded the history quota but left the snapshots in place. The
    // item_history → items cascade never fired, because a purge tombstones that row rather than
    // deleting it, so every version of a "permanently deleted" note stayed readable through
    // GET /items/:id/history until the GC swept the tombstone 30 days later — ciphertext plus an
    // encrypted_item_key still wrapped under the live Vault Key.
    test("a permanent delete takes the note's version history with it", async () => {
        const noteId = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(noteId),
        });
        expect(created.statusCode).toBe(201);

        const snapshot = await app.inject({
            method: "POST",
            url: `/items/${noteId}/history`,
            headers: { cookie },
            payload: {
                item_id: noteId,
                encrypted_payload: Buffer.alloc(64, 7).toString("base64"),
                payload_nonce: Buffer.alloc(24, 2).toString("base64"),
                encrypted_item_key: Buffer.alloc(48, 3).toString("base64"),
                item_key_nonce: Buffer.alloc(24, 4).toString("base64"),
                item_version_at_snapshot: created.json().version,
            },
        });
        expect(snapshot.statusCode).toBe(201);

        const before = await app.inject({
            method: "GET",
            url: `/items/${noteId}/history`,
            headers: { cookie },
        });
        expect(before.json().snapshots).toHaveLength(1);

        await trashItem(noteId);
        const purged = await app.inject({
            method: "DELETE",
            url: `/items/${noteId}/purge`,
            headers: { cookie },
        });
        expect(purged.statusCode).toBe(200);

        // Gone from the database, not merely hidden — the rows themselves must not survive.
        const rows = await db.select().from(itemHistory).where(eq(itemHistory.item_id, noteId));
        expect(rows).toHaveLength(0);

        // ...and the route no longer treats the tombstone as a readable item.
        const after = await app.inject({
            method: "GET",
            url: `/items/${noteId}/history`,
            headers: { cookie },
        });
        expect(after.statusCode).toBe(404);
    });
});
