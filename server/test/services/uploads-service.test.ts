// Unit tests for the shared upload/purge helpers.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import { abortAllUserUploads, purgeUserData } from "../../src/services/uploads-service";
import {
    countChunkSets,
    countFileChunks,
    countItemRows,
    getChunkSetPendingDeleteAt,
    getUploadSessionStatus,
    getUserStorageUsed,
    insertChunkSet,
    insertFileChunk,
    insertLiveItem,
    insertUploadSession,
    insertUser,
    resetDb,
    setUserStorage,
} from "../helpers";

const nowSec = () => Math.floor(Date.now() / 1000);
const EMAIL = "user-1@test.com";

async function userExists(id: string): Promise<boolean> {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
    return !!row;
}

describe("abortAllUserUploads", () => {
    beforeEach(resetDb);

    test("releases the reservation, deletes file_chunks and aborts every uploading session", async () => {
        await insertUser();
        await setUserStorage(EMAIL, 10_000, 3_000); // 3000 reserved (1000 + 2000)
        await insertUploadSession("up-1", "user-1", "uploading", nowSec(), 1_000);
        await insertUploadSession("up-2", "user-1", "uploading", nowSec(), 2_000);
        await insertFileChunk("up-1", 0, "user-1", 1_000);
        await insertFileChunk("up-2", 0, "user-1", 2_000);

        await db.transaction((tx) => abortAllUserUploads(tx, "user-1"));

        expect(await getUserStorageUsed(EMAIL)).toBe(0);
        expect(await getUploadSessionStatus("up-1")).toBe("aborted");
        expect(await getUploadSessionStatus("up-2")).toBe("aborted");
        expect(await countFileChunks("up-1")).toBe(0);
        expect(await countFileChunks("up-2")).toBe(0);
    });

    test("it touches neither committed sessions nor their quota", async () => {
        await insertUser();
        await setUserStorage(EMAIL, 10_000, 5_000);
        await insertUploadSession("committed-1", "user-1", "committed", nowSec(), 5_000);

        await db.transaction((tx) => abortAllUserUploads(tx, "user-1"));

        expect(await getUploadSessionStatus("committed-1")).toBe("committed");
        expect(await getUserStorageUsed(EMAIL)).toBe(5_000); // unchanged
    });

    test("storage_used_files never goes below zero (the GREATEST guard)", async () => {
        await insertUser();
        await setUserStorage(EMAIL, 10_000, 500); // less than the reservation
        await insertUploadSession("up-1", "user-1", "uploading", nowSec(), 1_000);

        await db.transaction((tx) => abortAllUserUploads(tx, "user-1"));

        expect(await getUserStorageUsed(EMAIL)).toBe(0);
    });

    test("a no-op when there are no uploading sessions", async () => {
        await insertUser();
        await setUserStorage(EMAIL, 10_000, 2_000);
        await db.transaction((tx) => abortAllUserUploads(tx, "user-1"));
        expect(await getUserStorageUsed(EMAIL)).toBe(2_000);
    });
});

describe("purgeUserData", () => {
    beforeEach(resetDb);

    test("deletes the user, leaves chunk_sets with pending_delete, and clears file_chunks and in-flight sessions", async () => {
        await insertUser();
        await setUserStorage(EMAIL, 10_000, 3_000);

        // Committed file: chunk_set + chunk + live item
        await insertChunkSet("set-1", "user-1", { totalSize: 2_000, pendingDeleteAt: null });
        await insertFileChunk("set-1", 0, "user-1", 2_000);
        await insertLiveItem("item-1", "user-1", "set-1");

        // In-flight upload
        await insertUploadSession("up-1", "user-1", "uploading", nowSec(), 1_000);
        await insertFileChunk("up-1", 0, "user-1", 1_000);

        await db.transaction((tx) => purgeUserData(tx, "user-1"));

        // The user is deleted; the item is deleted by cascade
        expect(await userExists("user-1")).toBe(false);
        expect(await countItemRows("item-1")).toBe(0);

        // The chunk_sets row survives (it has no FK to users) and is marked pending_delete
        expect(await countChunkSets()).toBe(1);
        expect(await getChunkSetPendingDeleteAt("set-1")).toBeGreaterThan(0);

        // every one of the user's file_chunks was deleted (both sets)
        expect(await countFileChunks("set-1")).toBe(0);
        expect(await countFileChunks("up-1")).toBe(0);
    });

    test("it does not overwrite an existing pending_delete_at on a chunk set", async () => {
        await insertUser();
        await insertChunkSet("set-1", "user-1", { totalSize: 1_000, pendingDeleteAt: 123 });

        await db.transaction((tx) => purgeUserData(tx, "user-1"));

        expect(await getChunkSetPendingDeleteAt("set-1")).toBe(123);
    });
});
