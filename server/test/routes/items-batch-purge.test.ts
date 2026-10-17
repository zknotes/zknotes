// `POST /items/batch delete_ids` runs through `purgeOwnedItemsBatch` — a fixed number of statements
// for the whole list instead of ~8 per id inside a transaction that holds the `users` row lock. These
// tests pin the semantics the per-id path had (quota buckets, the version-aware refusal, the
// tombstone shape, sync_deleted_log) on the cases where a batched implementation can drift: several
// ids at once, a shared chunk set, history, duplicates.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { itemHistory, items, users } from "../../src/db/schema";
import {
    createSeededFileItem,
    createTestUser,
    db,
    filePayload,
    getChunkSetPendingDeleteAt,
    getDeletedLogEntries,
    getUserStorageUsed,
    getUserStorageUsedItems,
    getUserStorageUsedTrash,
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

async function createNote(): Promise<string> {
    const id = uuidv7();
    const res = await app.inject({
        method: "POST",
        url: "/items",
        headers: { cookie },
        payload: notePayload(id),
    });
    expect(res.statusCode).toBe(201);
    return id;
}

async function trashItem(itemId: string) {
    const res = await app.inject({
        method: "DELETE",
        url: `/items/${itemId}`,
        headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
}

async function batchDelete(delete_ids: unknown[]) {
    const res = await app.inject({
        method: "POST",
        url: "/items/batch",
        headers: { cookie },
        payload: { upsert: [], delete_ids },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
        succeeded: unknown[];
        conflicts: { id: string; current_version: number; current_item: { id: string } }[];
        errors: unknown[];
    };
}

async function readRows(ids: string[]) {
    return db.select().from(items).where(inArray(items.id, ids));
}

async function historyBytes(): Promise<number> {
    const [row] = await db
        .select({ h: users.storage_used_history })
        .from(users)
        .where(eq(users.email, userEmail))
        .limit(1);
    return row?.h ?? 0;
}

describe("POST /items/batch delete_ids — the batched purge", () => {
    test("several notes in one batch: every row tombstoned, one log row each, items counter released", async () => {
        const ids = [await createNote(), await createNote(), await createNote()];
        expect(await getUserStorageUsedItems(userEmail)).toBeGreaterThan(0);

        const body = await batchDelete(ids);

        expect(body.conflicts).toHaveLength(0);
        const rows = await readRows(ids);
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row.purged_at).toBeGreaterThan(0);
            expect(row.deleted_at).toBeGreaterThan(0);
            expect(row.version).toBe(2);
            expect(row.encrypted_payload).toBeNull();
            expect(row.encrypted_item_key).toBeNull();
        }
        for (const id of ids) expect(await getDeletedLogEntries(id)).toHaveLength(1);
        expect(await getUserStorageUsedItems(userEmail)).toBe(0);
        expect(await getUserStorageUsedTrash(userEmail)).toBe(0);
    });

    test("a trashed note and a live note in the same batch release the right buckets", async () => {
        const trashed = await createNote();
        const live = await createNote();
        await trashItem(trashed);
        expect(await getUserStorageUsedTrash(userEmail)).toBeGreaterThan(0);
        expect(await getUserStorageUsedItems(userEmail)).toBeGreaterThan(0);

        await batchDelete([trashed, live]);

        expect(await getUserStorageUsedTrash(userEmail)).toBe(0);
        expect(await getUserStorageUsedItems(userEmail)).toBe(0);
    });

    test("version-aware: a stale version is refused with current_item while the other ids are purged", async () => {
        const kept = await createNote();
        const purged = await createNote();

        const body = await batchDelete([
            { id: kept, version: 99 },
            { id: purged, version: 1 },
        ]);

        expect(body.conflicts).toHaveLength(1);
        expect(body.conflicts[0]?.id).toBe(kept);
        expect(body.conflicts[0]?.current_version).toBe(1);
        expect(body.conflicts[0]?.current_item.id).toBe(kept);

        const [keptRow] = await readRows([kept]);
        expect(keptRow?.purged_at).toBeNull();
        expect(keptRow?.encrypted_payload).not.toBeNull();
        expect(await getDeletedLogEntries(kept)).toHaveLength(0);

        const [purgedRow] = await readRows([purged]);
        expect(purgedRow?.purged_at).toBeGreaterThan(0);
        expect(await getDeletedLogEntries(purged)).toHaveLength(1);
    });

    test("a shared chunk set (a file plus its conflict copy) purged in one batch is released exactly once", async () => {
        const { itemId: original, chunkSetId } = await createSeededFileItem(
            app,
            cookie,
            userEmail,
            FILE_SIZE,
        );
        // The conflict copy shares the immutable chunk set — no second reservation.
        const copyId = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(copyId, chunkSetId),
        });
        expect(created.statusCode).toBe(201);
        expect(await getUserStorageUsed(userEmail)).toBe(FILE_SIZE);

        await batchDelete([original, copyId]);

        expect(await getChunkSetPendingDeleteAt(chunkSetId)).toBeGreaterThan(0);
        // Released once from `files` — a double release would drive the counter below zero.
        expect(await getUserStorageUsed(userEmail)).toBe(0);
        expect(await getUserStorageUsedTrash(userEmail)).toBe(0);
        const rows = await readRows([original, copyId]);
        for (const row of rows) {
            expect(row.purged_at).toBeGreaterThan(0);
            expect(row.chunk_set_id).toBeNull();
        }
    });

    test("a shared chunk set stays when only one of its referencing items is purged", async () => {
        const { itemId: original, chunkSetId } = await createSeededFileItem(
            app,
            cookie,
            userEmail,
            FILE_SIZE,
        );
        const copyId = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(copyId, chunkSetId),
        });
        expect(created.statusCode).toBe(201);

        await batchDelete([original]);

        expect(await getChunkSetPendingDeleteAt(chunkSetId)).toBeNull();
        expect(await getUserStorageUsed(userEmail)).toBe(FILE_SIZE);
    });

    test("a note with history: the snapshots are deleted and the history counter released", async () => {
        const noteId = await createNote();
        const snap = await app.inject({
            method: "POST",
            url: `/items/${noteId}/history`,
            headers: { cookie },
            payload: {
                item_id: noteId,
                encrypted_payload: "cGF5bG9hZA==",
                payload_nonce: "A".repeat(32),
                encrypted_item_key: "C".repeat(64),
                item_key_nonce: "B".repeat(32),
                item_version_at_snapshot: 1,
            },
        });
        expect(snap.statusCode).toBe(201);
        expect(await historyBytes()).toBeGreaterThan(0);

        await batchDelete([noteId]);

        expect(await historyBytes()).toBe(0);
        const snapshots = await db
            .select()
            .from(itemHistory)
            .where(eq(itemHistory.item_id, noteId));
        expect(snapshots).toHaveLength(0);
    });

    test("duplicate ids in one batch purge once and log once; unknown and already-purged ids are a silent success", async () => {
        const noteId = await createNote();
        const alreadyPurged = await createNote();
        await batchDelete([alreadyPurged]);
        const before = await getUserStorageUsedItems(userEmail);

        const body = await batchDelete([noteId, noteId, uuidv7(), alreadyPurged]);

        expect(body.conflicts).toHaveLength(0);
        expect(await getDeletedLogEntries(noteId)).toHaveLength(1);
        expect(await getDeletedLogEntries(alreadyPurged)).toHaveLength(1);
        const [row] = await readRows([noteId]);
        expect(row?.version).toBe(2);
        // Exactly one payload's worth of bytes left the counter — not two.
        expect(await getUserStorageUsedItems(userEmail)).toBeLessThan(before);
        expect(await getUserStorageUsedItems(userEmail)).toBe(0);
    });

    test("a version-aware entry for an already-purged id is not a conflict", async () => {
        const noteId = await createNote();
        await batchDelete([noteId]);

        const body = await batchDelete([{ id: noteId, version: 1 }]);

        expect(body.conflicts).toHaveLength(0);
    });
});
