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
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { items, users } from "../../src/db/schema";
import * as itemService from "../../src/services/item-service";
import {
    createTestUser,
    filePayload,
    folderPayload,
    getUserIdByEmail,
    getUserStorageUsed,
    getUserStorageUsedItems,
    getUserStorageUsedTrash,
    insertChunkSet,
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

// ── GET /items ────────────────────────────────────────────────────────────────

describe("GET /items", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({ method: "GET", url: "/items?limit=1000" });
        expect(res.statusCode).toBe(401);
    });

    test("an empty list for a new user", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.items).toEqual([]);
        expect(body.server_time).toBeGreaterThan(0);
    });

    test("returns the created item", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        const res = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        const body = res.json();
        expect(body.items).toHaveLength(1);
        expect(body.items[0].id).toBe(id);
    });
});

// ── POST /items ───────────────────────────────────────────────────────────────

describe("POST /items", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/items",
            payload: notePayload(uuidv7()),
        });
        expect(res.statusCode).toBe(401);
    });

    test("creates a note → 201", async () => {
        const id = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.id).toBe(id);
        expect(body.version).toBe(1);
    });

    // Regression: insertItemRow never wrote deleted_at or
    // trashed_batch_id — an offline-created and offline-trashed item (never pushed while READY)
    // resurrected as READY on EVERY other device as soon as it first reached the server.
    test("creating an item with deleted_at keeps it trashed (offline note trashed before first sync)", async () => {
        const id = uuidv7();
        const batchId = uuidv7();
        const deletedAt = Math.floor(Date.now() / 1000) - 5;
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id, { deleted_at: deletedAt, trashed_batch_id: batchId }),
        });

        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.deleted_at).toBe(deletedAt);
        expect(body.trashed_batch_id).toBe(batchId);

        const [row] = await db.select().from(items).where(eq(items.id, id));
        expect(row?.deleted_at).toBe(deletedAt);
        expect(row?.trashed_batch_id).toBe(batchId);
    });

    test("creating with a nonexistent parent → 400 (Parent not found)", async () => {
        const id = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id, { parent_id: uuidv7() }), // the parent does not exist
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("Parent");
    });

    test("creating a note under a note (the wrong parent type) → 400", async () => {
        const parentNote = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(parentNote),
        });
        const id = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id, { parent_id: parentNote }), // a note's parent has to be a folder
        });
        expect(res.statusCode).toBe(400);
    });

    test("idempotent: the same id twice → 200 the second time, with the same item", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        const res2 = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        expect(res2.statusCode).toBe(200);
        expect(res2.json().id).toBe(id);
    });

    // Regression: the idempotency check was scoped to (id, user_id), so
    // another user's existing id read as "does not exist" → insert → PK violation → uncaught error
    // → 500. The difference between 500 (id taken) and 201 (id free) is an oracle for the existence
    // of another user's UUID. Expected: 409 item_id_taken.
    test("creating an item with an id owned by another user returns 409", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        const other = await createTestUser(app, { email: "other-owner@example.com" });
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie: other.cookie },
            payload: notePayload(id),
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("item_id_taken");
    });

    test("creates a folder → 201", async () => {
        const id = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: folderPayload(id),
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().type).toBe("folder");
    });

    test("encrypted_payload is stored and returned as base64", async () => {
        const id = uuidv7();
        const payload = "dGVzdGluZw=="; // base64("testing")
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id, { encrypted_payload: payload }),
        });

        const res = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        const item = res.json().items[0];
        expect(item.encrypted_payload).toBe(payload);
    });
});

// ── PUT /items/:id ────────────────────────────────────────────────────────────

describe("PUT /items/:id", () => {
    test("the correct version → 200, version++", async () => {
        const id = uuidv7();
        const createRes = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        expect(createRes.statusCode).toBe(201);
        expect(createRes.json().version).toBe(1);

        const updateRes = await app.inject({
            method: "PUT",
            url: `/items/${id}`,
            headers: { cookie },
            payload: {
                version: 1,
                encrypted_payload: "dXBkYXRlZA==",
                payload_nonce: "E".repeat(32),
                encrypted_item_key: "C".repeat(64),
                item_key_nonce: "F".repeat(32),
            },
        });

        expect(updateRes.statusCode).toBe(200);
        expect(updateRes.json().version).toBe(2);
    });

    test("the wrong version → 409 with current_item", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        const res = await app.inject({
            method: "PUT",
            url: `/items/${id}`,
            headers: { cookie },
            payload: { version: 99, encrypted_payload: "abc" },
        });

        expect(res.statusCode).toBe(409);
        const body = res.json();
        expect(body.error).toContain("version");
        expect(body.current_item).toBeTruthy();
    });

    test("a non-existent id → 404", async () => {
        const res = await app.inject({
            method: "PUT",
            url: `/items/${uuidv7()}`,
            headers: { cookie },
            payload: { version: 1 },
        });
        expect(res.statusCode).toBe(404);
    });

    test("without a session → 401", async () => {
        const res = await app.inject({
            method: "PUT",
            url: `/items/${uuidv7()}`,
            payload: { version: 1 },
        });
        expect(res.statusCode).toBe(401);
    });

    test("moving a folder into its own child → 400 cycle", async () => {
        // Create A (root) and B (a child of A)
        const aId = uuidv7();
        const bId = uuidv7();

        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: folderPayload(aId, null, { sort_order: "a" }),
        });
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: folderPayload(bId, aId, { sort_order: "b" }),
        });

        // Try to move A so it becomes a child of B → cycle
        const res = await app.inject({
            method: "PUT",
            url: `/items/${aId}`,
            headers: { cookie },
            payload: { version: 1, parent_id: bId },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("ycle");
    });
});

// ── DELETE /items/:id ─────────────────────────────────────────────────────────

describe("DELETE /items/:id", () => {
    test("a soft delete → 200, deleted_at is set, the ciphertext stays", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        const delRes = await app.inject({
            method: "DELETE",
            url: `/items/${id}`,
            headers: { cookie },
        });
        expect(delRes.statusCode).toBe(200);

        // The tombstone has to stay for the sync protocol; encrypted_* is NOT nulled (parity with the batch trash).
        const listRes = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        const items = listRes.json().items;
        const tombstone = items.find((i: any) => i.id === id);
        expect(tombstone).toBeTruthy();
        expect(tombstone.deleted_at).toBeGreaterThan(0);
        expect(tombstone.encrypted_payload).toBeTruthy();
        expect(tombstone.encrypted_item_key).toBeTruthy();
    });

    test("a non-existent id → 404", async () => {
        const res = await app.inject({
            method: "DELETE",
            url: `/items/${uuidv7()}`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(404);
    });

    test("without a session → 401", async () => {
        const res = await app.inject({
            method: "DELETE",
            url: `/items/${uuidv7()}`,
        });
        expect(res.statusCode).toBe(401);
    });
});

// ── POST /items/batch ─────────────────────────────────────────────────────────

describe("POST /items/batch", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            payload: { upsert: [], delete_ids: [] },
        });
        expect(res.statusCode).toBe(401);
    });

    test("a batch create of several items → all in succeeded", async () => {
        const id1 = uuidv7();
        const id2 = uuidv7();

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [notePayload(id1), notePayload(id2)],
                delete_ids: [],
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.succeeded).toHaveLength(2);
        expect(body.conflicts).toHaveLength(0);
        expect(body.errors).toHaveLength(0);
    });

    // Regression: the same oracle POST /items was hardened against survived in the
    // batch branch, where it was worse — getOwnedItem filters by user_id, so another user's id read
    // as "does not exist", the create branch ran, the insert died on the primary key and the WHOLE
    // transaction rolled back with a 500, destroying every legitimate item alongside it.
    test("a batch carrying another user's id reports item_id_taken and keeps the rest", async () => {
        const foreignId = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(foreignId),
        });
        expect(created.statusCode).toBe(201);

        const other = await createTestUser(app, { email: "batch-other@example.com" });
        const ownId = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie: other.cookie },
            payload: {
                upsert: [notePayload(ownId), notePayload(foreignId)],
                delete_ids: [],
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.errors).toEqual([{ id: foreignId, error: "item_id_taken" }]);
        // The legitimate item in the same batch survived.
        expect(body.succeeded.map((i: { id: string }) => i.id)).toEqual([ownId]);

        const pull = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie: other.cookie },
        });
        expect(pull.json().items.map((i: { id: string }) => i.id)).toContain(ownId);

        // The victim's row is untouched.
        const [victim] = await db.select().from(items).where(eq(items.id, foreignId));
        expect(victim?.version).toBe(1);
    });

    // Regression: the same bug, in the batch create branch (it shares insertItemRow with
    // POST /items through createItemTx).
    test("batch create with deleted_at keeps the item trashed", async () => {
        const id = uuidv7();
        const batchId = uuidv7();
        const deletedAt = Math.floor(Date.now() / 1000) - 5;

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [notePayload(id, { deleted_at: deletedAt, trashed_batch_id: batchId })],
                delete_ids: [],
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.succeeded).toHaveLength(1);
        expect(body.succeeded[0].deleted_at).toBe(deletedAt);
        expect(body.succeeded[0].trashed_batch_id).toBe(batchId);

        const [row] = await db.select().from(items).where(eq(items.id, id));
        expect(row?.deleted_at).toBe(deletedAt);
    });

    test("a batch with a version conflict → the conflict in the conflicts field, the rest succeeded", async () => {
        const id1 = uuidv7();
        const id2 = uuidv7();

        // Create id1 through the API
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id1),
        });

        // The batch: id1 with a wrong version (a conflict), id2 new (a success)
        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    notePayload(id1, { version: 99 }), // conflict
                    notePayload(id2), // new, should succeed
                ],
                delete_ids: [],
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.conflicts).toHaveLength(1);
        expect(body.conflicts[0].id).toBe(id1);
        expect(body.succeeded.some((i: any) => i.id === id2)).toBe(true);
    });

    test("batch delete → the items become tombstones", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [id] },
        });

        expect(res.statusCode).toBe(200);

        const listRes = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        const item = listRes.json().items.find((i: any) => i.id === id);
        expect(item.deleted_at).toBeGreaterThan(0);
    });

    test("version-aware delete: a stale version does NOT purge (the item stays alive)", async () => {
        const id = uuidv7();
        // Create a note (v1), then update it → v2 (as if another device had edited it).
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        await app.inject({
            method: "PUT",
            url: `/items/${id}`,
            headers: { cookie },
            payload: { version: 1, encrypted_payload: "abc" },
        });

        // A stale delete carrying version 1 → the server (at v2) must NOT purge.
        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [{ id, version: 1 }] },
        });
        expect(res.statusCode).toBe(200);

        const listRes = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        const item = listRes.json().items.find((i: any) => i.id === id);
        expect(item).toBeDefined();
        expect(item.purged_at ?? null).toBeNull(); // the work is preserved, not destroyed
    });

    test("version-aware delete: the correct version purges the item", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [{ id, version: 1 }] },
        });
        expect(res.statusCode).toBe(200);

        const listRes = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        const item = listRes.json().items.find((i: any) => i.id === id);
        expect(item.purged_at).toBeGreaterThan(0);
    });

    test("a child before its parent in the same batch → both succeed (topo sort)", async () => {
        const parentId = uuidv7();
        const childId = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                // The child BEFORE the parent — without the topo sort the child would fail with "Parent not found".
                upsert: [
                    folderPayload(childId, parentId, { sort_order: "b" }),
                    folderPayload(parentId, null, { sort_order: "a" }),
                ],
                delete_ids: [],
            },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.errors).toHaveLength(0);
        expect(body.succeeded.map((s: any) => s.id).sort()).toEqual([parentId, childId].sort());
    });

    test("a batch update of a purged row → error, and the ciphertext does not come back", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        // Purge it (a version-aware delete).
        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [], delete_ids: [{ id, version: 1 }] },
        });

        // Try to update a purged row.
        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [notePayload(id, { version: 2, encrypted_payload: "cmVzdXJyZWN0" })],
                delete_ids: [],
            },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0].id).toBe(id);

        // The row stays purged, and the payload did not come back.
        const [row] = await db.select().from(items).where(eq(items.id, id)).limit(1);
        expect(row?.purged_at).toBeGreaterThan(0);
        expect(row?.encrypted_payload).toBeNull();
    });

    test("a batch that creates a cycle in the folder hierarchy → 400, rollback", async () => {
        // Create folder A (root) and folder B (a child of A)
        const aId = uuidv7();
        const bId = uuidv7();

        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    folderPayload(aId, null, { sort_order: "a" }),
                    folderPayload(bId, aId, { sort_order: "b" }),
                ],
                delete_ids: [],
            },
        });

        // Try to move A so it becomes a child of B → cycle!
        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [folderPayload(aId, bId, { sort_order: "a", version: 1 })],
                delete_ids: [],
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain("ycle");

        // Check that folder A was not changed (rollback)
        const listRes = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        const folderA = listRes.json().items.find((i: any) => i.id === aId);
        expect(folderA.parent_id).toBeNull();
    });

    // Regression: fileCountExceeded ran one COUNT(*) over ALL of a user's
    // items PER NEW file item in the batch (O(N·M)). A batch of 20 new files →
    // countLiveFiles may be called ONCE, not 20 times.
    test("file count is checked once per batch, not once per new file item", async () => {
        const spy = spyOn(itemService, "countLiveFiles");
        spy.mockClear();

        const upsert = Array.from({ length: 20 }, () =>
            filePayload(uuidv7(), "unused", { chunk_set_id: null, chunk_count: null }),
        );

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert, delete_ids: [] },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().succeeded).toHaveLength(20);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

// ── Synced trash (7b): the upsert persists deleted_at and GET returns it ───────

describe("POST /items/batch — synced trash", () => {
    async function getItem(id: string) {
        const res = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        return res.json().items.find((i: any) => i.id === id);
    }

    test("a trash through the upsert (deleted_at) is persisted, and the version is bumped", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [notePayload(id, { version: 1, deleted_at: 1700000000 })],
                delete_ids: [],
            },
        });
        expect(res.statusCode).toBe(200);

        const item = await getItem(id);
        expect(item.deleted_at).toBe(1700000000);
        expect(item.version).toBe(2);
    });

    test("a restore through the upsert (deleted_at=null) clears the trash state", async () => {
        const id = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [notePayload(id, { version: 1, deleted_at: 123 })], delete_ids: [] },
        });

        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [notePayload(id, { version: 2, deleted_at: null })],
                delete_ids: [],
            },
        });

        const item = await getItem(id);
        expect(item.deleted_at).toBeNull();
        expect(item.version).toBe(3);
    });

    test("a trash upsert persists trashed_batch_id on the note and its file descendants", async () => {
        const noteId = uuidv7();
        const fileId = uuidv7();
        const batchId = uuidv7();
        const chunkSetId = uuidv7();
        const userId = await getUserIdByEmail(userEmail);
        if (!userId) throw new Error("test user missing");

        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(noteId),
        });
        await insertChunkSet(chunkSetId, userId);
        const fileCreate = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(fileId, chunkSetId, { parent_id: noteId }),
        });
        expect(fileCreate.statusCode).toBe(201);

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    notePayload(noteId, {
                        version: 1,
                        deleted_at: 1700000000,
                        trashed_batch_id: batchId,
                    }),
                    filePayload(fileId, chunkSetId, {
                        parent_id: noteId,
                        version: 1,
                        deleted_at: 1700000000,
                        trashed_batch_id: batchId,
                    }),
                ],
                delete_ids: [],
            },
        });
        expect(res.statusCode).toBe(200);

        const note = await getItem(noteId);
        const file = await getItem(fileId);
        expect(note.trashed_batch_id).toBe(batchId);
        expect(file.trashed_batch_id).toBe(batchId);
    });

    // Regression: chunkSetCommitted checked only "exists and belongs to the user", not
    // pending_delete_at. A chunk set awaiting physical deletion (after a purge or a crop swap)
    // still passed as "committed" — a file conflict copy (which shares chunk_set_id by design)
    // could bind itself to a blob that GC really deletes an hour later.
    // Regression: a shared chunk_set_id (a file plus its conflict copy) moved the quota twice
    // once BOTH referencing items had gone through trash/restore — storage_used_trash grew 2× even
    // though the "files" quota is charged only ONCE (at upload finalize), and the drift accumulated
    // symmetrically on restore.
    test("trashing two items that share a chunk set moves the bytes only once", async () => {
        const fileAId = uuidv7();
        const fileBId = uuidv7();
        const chunkSetId = uuidv7();
        const totalSize = 5000;
        const userId = await getUserIdByEmail(userEmail);
        if (!userId) throw new Error("test user missing");

        await insertChunkSet(chunkSetId, userId, { totalSize });
        // Simulate the upload having reserved the "files" quota ONCE for the shared set.
        await db
            .update(users)
            .set({ storage_used_files: sql`storage_used_files + ${totalSize}` })
            .where(eq(users.email, userEmail));

        const createA = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(fileAId, chunkSetId),
        });
        expect(createA.statusCode).toBe(201);
        const createB = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(fileBId, chunkSetId),
        });
        expect(createB.statusCode).toBe(201);

        // Each item's payload now moves into `trash` alongside the blob. The
        // baseline is taken from `storage_used_items` BEFORE the trash, so the test still proves what
        // it exists for: the blob (`totalSize`) may move ONLY ONCE, however many items share it.
        const payloadsBefore = await getUserStorageUsedItems(userEmail);
        expect(payloadsBefore).toBeGreaterThan(0);

        const trashRes = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    filePayload(fileAId, chunkSetId, { version: 1, deleted_at: 1700000000 }),
                    filePayload(fileBId, chunkSetId, { version: 1, deleted_at: 1700000000 }),
                ],
                delete_ids: [],
            },
        });
        expect(trashRes.statusCode).toBe(200);
        // The blob once plus both payloads. Had the blob moved twice, it would be 2 * totalSize + payloads.
        expect(await getUserStorageUsedTrash(userEmail)).toBe(totalSize + payloadsBefore);
        expect(await getUserStorageUsedItems(userEmail)).toBe(0);
        expect(await getUserStorageUsed(userEmail)).toBe(0);

        const restoreRes = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    filePayload(fileAId, chunkSetId, { version: 2, deleted_at: null }),
                    filePayload(fileBId, chunkSetId, { version: 2, deleted_at: null }),
                ],
                delete_ids: [],
            },
        });
        expect(restoreRes.statusCode).toBe(200);
        // Symmetrically back — with no drift in either bucket.
        expect(await getUserStorageUsedTrash(userEmail)).toBe(0);
        expect(await getUserStorageUsedItems(userEmail)).toBe(payloadsBefore);
        expect(await getUserStorageUsed(userEmail)).toBe(totalSize);
    });

    test("create file on pending_delete chunk set reclaims set (file conflict share)", async () => {
        // A conflict copy shares its chunk set with the purged original — the server may
        // clear pending_delete_at when a new live ref arrives (a reclaim), instead of answering 409.
        const chunkSetId = uuidv7();
        const userId = await getUserIdByEmail(userEmail);
        if (!userId) throw new Error("test user missing");
        await insertChunkSet(chunkSetId, userId, {
            pendingDeleteAt: Math.floor(Date.now() / 1000),
            totalSize: 1000,
        });

        const id = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(id, chunkSetId),
        });

        expect(res.statusCode).toBe(201);
        expect(res.json().chunk_set_id).toBe(chunkSetId);
        // Reclaim plus the files quota: the set may be used again (not a 409)
    });

    test("cannot create a file item referencing a non-existent chunk set", async () => {
        const id = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(id, uuidv7()),
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("Referenced chunk set is not committed");
    });

    test("POST a note carrying another user's chunk_set_id is rejected", async () => {
        const other = await createTestUser(app, { email: "chunk-victim@example.com" });
        const victimId = await getUserIdByEmail(other.email);
        if (!victimId) throw new Error("victim user missing");
        const chunkSetId = uuidv7();
        await insertChunkSet(chunkSetId, victimId, { totalSize: 1000 });

        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(uuidv7(), { chunk_set_id: chunkSetId }),
        });
        expect(res.statusCode).toBe(400);
    });

    test("a restore upsert clears trashed_batch_id when deleted_at=null", async () => {
        const id = uuidv7();
        const batchId = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    notePayload(id, {
                        version: 1,
                        deleted_at: 123,
                        trashed_batch_id: batchId,
                    }),
                ],
                delete_ids: [],
            },
        });

        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [notePayload(id, { version: 2, deleted_at: null })],
                delete_ids: [],
            },
        });

        const item = await getItem(id);
        expect(item.deleted_at).toBeNull();
        expect(item.trashed_batch_id).toBeNull();
    });
});

// ── deleted_at clamp (anti-abuse against the retention sweep — "immortal trash") ──

describe("deleted_at clamp — the server must not accept a future timestamp", () => {
    async function getItem(id: string) {
        const res = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        return res.json().items.find((i: any) => i.id === id);
    }

    async function createNote(id: string) {
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        expect(res.statusCode).toBe(201);
    }

    test("batch: a future deleted_at is clamped to <= now", async () => {
        const id = uuidv7();
        await createNote(id);

        const now = Math.floor(Date.now() / 1000);
        const future = now + 3600;

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [notePayload(id, { version: 1, deleted_at: future })],
                delete_ids: [],
            },
        });
        expect(res.statusCode).toBe(200);

        const item = await getItem(id);
        expect(item.deleted_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
        expect(item.deleted_at).toBeLessThan(future);
    });

    test("batch: a past deleted_at (offline trash) is left unchanged", async () => {
        const id = uuidv7();
        await createNote(id);

        const past = Math.floor(Date.now() / 1000) - 5 * 24 * 3600; // 5 days ago

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [notePayload(id, { version: 1, deleted_at: past })],
                delete_ids: [],
            },
        });
        expect(res.statusCode).toBe(200);

        const item = await getItem(id);
        expect(item.deleted_at).toBe(past);
    });

    test("batch: the trash→restore round trip still works (regression)", async () => {
        const id = uuidv7();
        await createNote(id);

        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    notePayload(id, { version: 1, deleted_at: Math.floor(Date.now() / 1000) }),
                ],
                delete_ids: [],
            },
        });
        const restore = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [notePayload(id, { version: 2, deleted_at: null })],
                delete_ids: [],
            },
        });
        expect(restore.statusCode).toBe(200);

        const item = await getItem(id);
        expect(item.deleted_at).toBeNull();
        expect(item.version).toBe(3);
    });

    test("PUT: changing the trash state (alive → deleted) → 409, and nothing is persisted", async () => {
        const id = uuidv7();
        await createNote(id);

        const res = await app.inject({
            method: "PUT",
            url: `/items/${id}`,
            headers: { cookie },
            payload: { version: 1, deleted_at: Math.floor(Date.now() / 1000) + 3600 },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toContain("Trash state");

        const item = await getItem(id);
        expect(item.deleted_at).toBeNull(); // it stayed alive
        expect(item.version).toBe(1); // not bumped
    });

    test("PUT: a full-entity live item with deleted_at=null (no state change) → 200", async () => {
        const id = uuidv7();
        await createNote(id);

        const res = await app.inject({
            method: "PUT",
            url: `/items/${id}`,
            headers: { cookie },
            payload: {
                version: 1,
                deleted_at: null,
                encrypted_payload: "dXBkYXRlZA==",
                payload_nonce: "E".repeat(32),
                encrypted_item_key: "C".repeat(64),
                item_key_nonce: "F".repeat(32),
            },
        });
        expect(res.statusCode).toBe(200);

        const item = await getItem(id);
        expect(item.deleted_at).toBeNull();
        expect(item.version).toBe(2);
    });

    test("PUT: a future deleted_at on an already-deleted item is clamped (the state stays trashed)", async () => {
        const id = uuidv7();
        await createNote(id);
        // First put it in Trash through the batch (the legitimate path).
        await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    notePayload(id, { version: 1, deleted_at: Math.floor(Date.now() / 1000) }),
                ],
                delete_ids: [],
            },
        });

        const future = Math.floor(Date.now() / 1000) + 3600;
        const res = await app.inject({
            method: "PUT",
            url: `/items/${id}`,
            headers: { cookie },
            payload: { version: 2, deleted_at: future },
        });
        expect(res.statusCode).toBe(200);

        const item = await getItem(id);
        expect(item.deleted_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
        expect(item.deleted_at).toBeLessThan(future);
    });
});

// ── The item-count ceiling ───────────────────────────────────────────────────
// The check existed in quota-service from the start, but nobody called it — the ceiling of 100,000
// items was never really enforced. The ENV override lowers the ceiling so the test does not have to
// write 100,000 rows; the source of truth stays ITEM_LIMITS.MAX_ITEMS_COUNT.

describe("the MAX_ITEMS_COUNT ceiling", () => {
    const original = process.env.MAX_ITEMS_COUNT;

    afterEach(() => {
        if (original === undefined) delete process.env.MAX_ITEMS_COUNT;
        else process.env.MAX_ITEMS_COUNT = original;
    });

    async function createNote(id: string) {
        return app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
    }

    test("a POST /items over the ceiling → 413 item_limit_exceeded, and the item is not written", async () => {
        process.env.MAX_ITEMS_COUNT = "2";

        expect((await createNote(uuidv7())).statusCode).toBe(201);
        expect((await createNote(uuidv7())).statusCode).toBe(201);

        const blockedId = uuidv7();
        const res = await createNote(blockedId);

        expect(res.statusCode).toBe(413);
        expect(res.json().error).toBe("item_limit_exceeded");

        const rows = await db.select().from(items).where(eq(items.id, blockedId));
        expect(rows).toHaveLength(0);
    });

    test("below the ceiling a create still passes", async () => {
        process.env.MAX_ITEMS_COUNT = "2";
        expect((await createNote(uuidv7())).statusCode).toBe(201);
    });

    test("batch: a create past the ceiling fails per item, while a delete in the same batch passes", async () => {
        process.env.MAX_ITEMS_COUNT = "2";

        const keepId = uuidv7();
        const deleteId = uuidv7();
        expect((await createNote(keepId)).statusCode).toBe(201);
        expect((await createNote(deleteId)).statusCode).toBe(201);

        const blockedId = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [notePayload(blockedId)], delete_ids: [deleteId] },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.errors).toContainEqual({ id: blockedId, error: "item_limit_exceeded" });
        expect(body.succeeded).toHaveLength(0);

        // Deletion does NOT depend on the ceiling — it has to pass even when the creates fail (partial success).
        const [deleted] = await db.select().from(items).where(eq(items.id, deleteId));
        expect(deleted?.deleted_at).not.toBeNull();

        const blocked = await db.select().from(items).where(eq(items.id, blockedId));
        expect(blocked).toHaveLength(0);
    });
});
