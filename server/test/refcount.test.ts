// Tests for blob-sweeper.ts (the V3 replacement for refcount.ts) plus releaseChunkSetIfUnreferenced.
// What is tested: chunkSetCommitted, markPendingDelete, the double-free guard.
import { beforeEach, describe, expect, test } from "bun:test";
import { chunkSetCommitted, markPendingDelete } from "../src/blob-sweeper";
import { db } from "../src/db";
import { items } from "../src/db/schema";
import { releaseChunkSetIfUnreferenced } from "../src/services/item-service";
import {
    getChunkSetPendingDeleteAt,
    getUserStorageUsed,
    insertChunkSet,
    insertLiveItem,
    insertUser,
    resetDb,
    setUserStorage,
} from "./helpers";

const nowSec = () => Math.floor(Date.now() / 1000);

describe("chunkSetCommitted", () => {
    beforeEach(resetDb);

    test("returns false for a nonexistent chunk set", async () => {
        await insertUser();
        expect(await chunkSetCommitted("nonexistent", "user-1")).toBe(false);
    });

    test("returns false when the user_id does not match", async () => {
        await insertUser();
        await insertUser("user-2");
        await insertChunkSet("set-1", "user-1");
        expect(await chunkSetCommitted("set-1", "user-2")).toBe(false);
    });

    test("returns true for an existing set with the correct user", async () => {
        await insertUser();
        await insertChunkSet("set-1", "user-1");
        expect(await chunkSetCommitted("set-1", "user-1")).toBe(true);
    });
});

describe("markPendingDelete", () => {
    beforeEach(resetDb);

    test("a null chunkSetId → false, and it does not throw", async () => {
        await insertUser();
        expect(await markPendingDelete(null, "user-1")).toBe(false);
    });

    test("an undefined chunkSetId → false, and it does not throw", async () => {
        await insertUser();
        expect(await markPendingDelete(undefined, "user-1")).toBe(false);
    });

    test("a nonexistent set → false, and it does not throw", async () => {
        await insertUser();
        expect(await markPendingDelete("ghost-set", "user-1")).toBe(false);
    });

    test("setting pending_delete_at on an active set → true", async () => {
        await insertUser();
        await insertChunkSet("set-1", "user-1", { pendingDeleteAt: null });

        const before = await getChunkSetPendingDeleteAt("set-1");
        expect(before).toBeNull();

        expect(await markPendingDelete("set-1", "user-1")).toBe(true);

        const after = await getChunkSetPendingDeleteAt("set-1");
        expect(after).toBeGreaterThan(0);
    });

    test("a second call does not reset the timestamp and returns false", async () => {
        await insertUser();
        const originalStamp = nowSec() - 500;
        await insertChunkSet("set-1", "user-1", { pendingDeleteAt: originalStamp });

        expect(await markPendingDelete("set-1", "user-1")).toBe(false);

        const after = await getChunkSetPendingDeleteAt("set-1");
        expect(after).toBe(originalStamp);
    });

    test("the wrong user_id → it does not touch someone else's set, false", async () => {
        await insertUser();
        await insertUser("user-2");
        await insertChunkSet("set-1", "user-1", { pendingDeleteAt: null });

        expect(await markPendingDelete("set-1", "user-2")).toBe(false);

        // The set of user-1 stays unchanged
        const after = await getChunkSetPendingDeleteAt("set-1");
        expect(after).toBeNull();
    });
});

describe("releaseChunkSetIfUnreferenced (double-free guard)", () => {
    beforeEach(resetDb);

    test("a double call frees the quota only once", async () => {
        await insertUser();
        await setUserStorage("user-1@test.com", 10_000_000, 5000);
        await insertChunkSet("set-1", "user-1", { totalSize: 2000, pendingDeleteAt: null });

        await db.transaction(async (tx) => {
            await releaseChunkSetIfUnreferenced(tx, "set-1", "user-1");
        });
        expect(await getUserStorageUsed("user-1@test.com")).toBe(3000);
        expect(await getChunkSetPendingDeleteAt("set-1")).not.toBeNull();

        await db.transaction(async (tx) => {
            await releaseChunkSetIfUnreferenced(tx, "set-1", "user-1");
        });
        // The second time it must not subtract another 2000
        expect(await getUserStorageUsed("user-1@test.com")).toBe(3000);
    });

    test("another user's note referencing the set does not block pending_delete", async () => {
        await insertUser();
        await insertUser("user-2");
        await setUserStorage("user-1@test.com", 10_000_000, 5000);
        await insertChunkSet("set-1", "user-1", { totalSize: 2000, pendingDeleteAt: null });
        await insertLiveItem("file-1", "user-1", "set-1");
        await db.insert(items).values({
            id: "note-attacker",
            user_id: "user-2",
            type: "note",
            sort_order: "m",
            chunk_set_id: "set-1",
            version: 1,
        });

        await db.transaction(async (tx) => {
            await releaseChunkSetIfUnreferenced(tx, "set-1", "user-1", "file-1");
        });

        expect(await getChunkSetPendingDeleteAt("set-1")).not.toBeNull();
        expect(await getUserStorageUsed("user-1@test.com")).toBe(3000);
    });
});
