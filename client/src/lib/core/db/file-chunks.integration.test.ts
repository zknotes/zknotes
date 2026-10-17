import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    chunkKey,
    clearAllLocalChunks,
    deleteChunkSet,
    getLocalChunk,
    getLocalChunkBytes,
    hasAllChunks,
    listChunkSetsByAge,
    putLocalChunk,
} from "./file-chunks";
import { getDB, type LocalChunk } from "./index";

function chunk(chunkSetId: string, index: number, size: number, storedAt = 1): LocalChunk {
    return {
        key: chunkKey(chunkSetId, index),
        chunkSetId,
        index,
        ciphertext: new Uint8Array(size).fill(index % 256),
        nonce: new Uint8Array(24).fill(7),
        storedAt,
    };
}

async function clear() {
    const db = await getDB();
    await db.clear("file-chunks");
}

beforeEach(async () => {
    vi.restoreAllMocks();
    await clear();
});

describe("file-chunks store", () => {
    it("put → get round-trips ciphertext + nonce", async () => {
        await putLocalChunk(chunk("cs1", 0, 8));
        const got = await getLocalChunk("cs1", 0);
        expect(got).toBeDefined();
        expect(got?.chunkSetId).toBe("cs1");
        expect(got?.ciphertext.byteLength).toBe(8);
        expect(got?.nonce.byteLength).toBe(24);
    });

    it("get returns undefined on miss", async () => {
        expect(await getLocalChunk("nope", 0)).toBeUndefined();
    });

    it("putLocalChunk returns false on IDB write error (quota fallback)", async () => {
        const db = await getDB();
        const spy = vi.spyOn(db, "put").mockRejectedValueOnce(new Error("QuotaExceededError"));
        expect(await putLocalChunk(chunk("cs1", 0, 8))).toBe(false);
        spy.mockRestore();
        // The next write (with no error) succeeds again.
        expect(await putLocalChunk(chunk("cs1", 0, 8))).toBe(true);
    });

    it("hasAllChunks true only when every index is present", async () => {
        await putLocalChunk(chunk("cs1", 0, 8));
        await putLocalChunk(chunk("cs1", 1, 8));
        expect(await hasAllChunks("cs1", 3)).toBe(false);
        await putLocalChunk(chunk("cs1", 2, 8));
        expect(await hasAllChunks("cs1", 3)).toBe(true);
    });

    it("hasAllChunks false for zero-count", async () => {
        expect(await hasAllChunks("cs1", 0)).toBe(false);
    });

    it("deleteChunkSet removes only the target set and returns freed bytes", async () => {
        await putLocalChunk(chunk("cs1", 0, 10));
        await putLocalChunk(chunk("cs1", 1, 10));
        await putLocalChunk(chunk("cs2", 0, 10));
        const freed = await deleteChunkSet("cs1");
        expect(freed).toBe(20);
        expect(await getLocalChunk("cs1", 0)).toBeUndefined();
        expect(await getLocalChunk("cs1", 1)).toBeUndefined();
        expect(await getLocalChunk("cs2", 0)).toBeDefined();
    });

    it("getLocalChunkBytes sums all ciphertext", async () => {
        await putLocalChunk(chunk("cs1", 0, 10));
        await putLocalChunk(chunk("cs2", 0, 30));
        expect(await getLocalChunkBytes()).toBe(40);
    });

    it("clearAllLocalChunks empties store and returns freed bytes", async () => {
        await putLocalChunk(chunk("cs1", 0, 10));
        await putLocalChunk(chunk("cs2", 0, 30));
        const freed = await clearAllLocalChunks();
        expect(freed).toBe(40);
        expect(await getLocalChunkBytes()).toBe(0);
        expect(await getLocalChunk("cs1", 0)).toBeUndefined();
    });

    it("listChunkSetsByAge groups by set, oldest first", async () => {
        await putLocalChunk(chunk("new", 0, 10, 200));
        await putLocalChunk(chunk("old", 0, 5, 100));
        await putLocalChunk(chunk("old", 1, 5, 150));
        const list = await listChunkSetsByAge();
        expect(list.map((s) => s.chunkSetId)).toEqual(["old", "new"]);
        expect(list[0]).toMatchObject({ chunkSetId: "old", bytes: 10, oldestStoredAt: 100 });
        expect(list[1]).toMatchObject({ chunkSetId: "new", bytes: 10, oldestStoredAt: 200 });
    });
});
