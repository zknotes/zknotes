import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDB, type LocalItem } from "$lib/core/db";
import { getUnsyncedWork, isVaultClean } from "./unsynced-work";

async function seedItem(over: Partial<LocalItem> & { id: string }): Promise<void> {
    const db = await getDB();
    await db.put("items", {
        type: "note",
        parent_id: null,
        encrypted_payload: "x",
        payload_nonce: "x",
        encrypted_item_key: "x",
        item_key_nonce: "x",
        sort_order: "m",
        version: 1,
        dirty: false,
        localRev: 0,
        ...over,
    } as LocalItem);
}

describe("getUnsyncedWork", () => {
    beforeEach(async () => {
        const db = await getDB();
        await db.clear("items");
        await db.clear("mutation-queue");
        await db.clear("pending-uploads");
    });

    it("an empty vault is clean", async () => {
        const work = await getUnsyncedWork();
        expect(work).toEqual({ dirtyCount: 0, failedCount: 0, uploadsActive: 0 });
        expect(isVaultClean(work)).toBe(true);
    });

    it("dirty + sync_error counts even with no row in the queue", async () => {
        await seedItem({ id: "n1", dirty: true, sync_error: "hard_limit_exceeded" });
        const work = await getUnsyncedWork();
        expect(work.dirtyCount).toBe(1);
        expect(work.failedCount).toBe(1);
        expect(isVaultClean(work)).toBe(false);
    });

    it("an item both dirty and queued is not counted twice", async () => {
        await seedItem({ id: "n1", dirty: true });
        const db = await getDB();
        await db.put("mutation-queue", {
            id: "n1",
            type: "upsert",
            attempted_at: 0,
            attempt_count: 0,
        });
        const work = await getUnsyncedWork();
        expect(work.dirtyCount).toBe(1);
    });

    it("a delete-only row in the queue (nothing dirty) is counted", async () => {
        await seedItem({ id: "tomb", dirty: false, purged_at: 1 });
        const db = await getDB();
        await db.put("mutation-queue", {
            id: "tomb",
            type: "delete",
            attempted_at: 0,
            attempt_count: 0,
        });
        const work = await getUnsyncedWork();
        expect(work.dirtyCount).toBe(1);
    });

    it("a non-terminal pending upload (failed_recoverable) counts, a done one does not", async () => {
        const db = await getDB();
        await db.put("pending-uploads", {
            local_id: "u1",
            phase: "failed_recoverable",
            name: "a.bin",
            mime: "application/octet-stream",
            note_id: null,
            parent_id: null,
            created_at: 0,
        });
        await db.put("pending-uploads", {
            local_id: "u2",
            phase: "done",
            name: "b.bin",
            mime: "application/octet-stream",
            note_id: null,
            parent_id: null,
            created_at: 0,
        });
        const work = await getUnsyncedWork();
        expect(work.uploadsActive).toBe(1);
        expect(isVaultClean(work)).toBe(false);
    });
});
