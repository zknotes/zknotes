import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A small cap (≈1 KB) set BEFORE the module import, so the LRU eviction becomes testable on small
// chunks. The hoisted callback runs before the import is evaluated (chunk-loader reads the cap into a
// top-level const).
vi.hoisted(() => {
    vi.stubEnv("VITE_FILE_CHUNK_CACHE_MAX_MB", "0.001"); // 0.001 MB ≈ 1048 B
});

const getChunkMock = vi.fn<(chunkSetId: string, index: number) => Promise<Uint8Array>>();
vi.mock("$lib/core/api", () => ({
    getChunk: (chunkSetId: string, index: number) => getChunkMock(chunkSetId, index),
}));

import { getDB } from "$lib/core/db";
import { getLocalChunk, getLocalChunkBytes } from "$lib/core/db/file-chunks";
import { __resetChunkCacheForTest, evictChunkSet, loadChunk } from "./chunk-loader";

const NONCE = new Uint8Array(24).fill(9);

function bytes(n: number, fill = 1): Uint8Array {
    return new Uint8Array(n).fill(fill);
}

beforeEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetChunkCacheForTest();
    const db = await getDB();
    await db.clear("file-chunks");
});

describe("loadChunk read-through", () => {
    it("first load fetches from network and persists ciphertext", async () => {
        getChunkMock.mockResolvedValue(bytes(8, 42));
        const out = await loadChunk("cs1", 0, NONCE);

        expect(getChunkMock).toHaveBeenCalledTimes(1);
        expect(Array.from(out)).toEqual(Array.from(bytes(8, 42)));
        const stored = await getLocalChunk("cs1", 0);
        expect(stored?.ciphertext.byteLength).toBe(8);
        expect(stored?.nonce.byteLength).toBe(24);
    });

    it("second load of same chunk hits cache (no network)", async () => {
        getChunkMock.mockResolvedValue(bytes(8, 42));
        await loadChunk("cs1", 0, NONCE);
        const second = await loadChunk("cs1", 0, NONCE);

        expect(getChunkMock).toHaveBeenCalledTimes(1); // still only the first (network) call
        expect(Array.from(second)).toEqual(Array.from(bytes(8, 42)));
    });

    it("persist failure (quota) still returns network bytes without throwing", async () => {
        getChunkMock.mockResolvedValue(bytes(8, 7));
        const db = await getDB();
        vi.spyOn(db, "put").mockRejectedValueOnce(new Error("QuotaExceededError"));

        const out = await loadChunk("cs1", 0, NONCE);
        expect(Array.from(out)).toEqual(Array.from(bytes(8, 7)));
        // The write failed → nothing was cached, but the decryption carries on.
        expect(await getLocalChunk("cs1", 0)).toBeUndefined();
    });
});

describe("LRU cap enforcement", () => {
    it("evicts the oldest chunk set once the cache exceeds the cap", async () => {
        getChunkMock.mockResolvedValue(bytes(500));
        await loadChunk("a", 0, NONCE); // 500 B
        await loadChunk("b", 0, NONCE); // 1000 B
        await loadChunk("c", 0, NONCE); // 1500 B → over the ~1048 B cap → it evicts the oldest ("a")

        expect(await getLocalChunk("a", 0)).toBeUndefined();
        expect(await getLocalChunk("b", 0)).toBeDefined();
        expect(await getLocalChunk("c", 0)).toBeDefined();
        expect(await getLocalChunkBytes()).toBeLessThanOrEqual(0.001 * 1024 * 1024);
    });

    it("never evicts the set currently being filled", async () => {
        // A single set larger than the cap may still stay cached (otherwise it would never be offline).
        getChunkMock.mockResolvedValue(bytes(800));
        await loadChunk("big", 0, NONCE);
        await loadChunk("big", 1, NONCE); // 1600 B > the cap, but the same set → nothing is evicted

        expect(await getLocalChunk("big", 0)).toBeDefined();
        expect(await getLocalChunk("big", 1)).toBeDefined();
    });

    it("preserves pinned chunk set during LRU eviction", async () => {
        // enforceCap computes the pinned set ONCE per eviction pass via
        // getPinnedChunkSetIds, not per-candidate isPinnedChunkSet calls.
        const { fileBridge } = await import("../events/file-bridge");
        fileBridge.getPinnedChunkSetIds = vi.fn(async () => new Set(["pinned-set"]));

        getChunkMock.mockResolvedValue(bytes(500));
        await loadChunk("pinned-set", 0, NONCE); // 500 B (pinned)
        await loadChunk("unpinned-a", 0, NONCE); // 500 B
        await loadChunk("unpinned-b", 0, NONCE); // 500 B → over the cap → it has to evict "unpinned-a", NOT "pinned-set"

        expect(await getLocalChunk("pinned-set", 0)).toBeDefined();
        expect(await getLocalChunk("unpinned-a", 0)).toBeUndefined();
        expect(await getLocalChunk("unpinned-b", 0)).toBeDefined();

        fileBridge.getPinnedChunkSetIds = undefined;
    });

    it("does not persist to IDB when opts.persist is false", async () => {
        getChunkMock.mockResolvedValue(bytes(100));
        const out = await loadChunk("one-shot", 0, NONCE, undefined, { persist: false });
        expect(out.byteLength).toBe(100);
        expect(await getLocalChunk("one-shot", 0)).toBeUndefined();
    });
});

describe("evictChunkSet", () => {
    it("removes a cached set and keeps the running total consistent", async () => {
        getChunkMock.mockResolvedValue(bytes(100));
        await loadChunk("cs1", 0, NONCE);
        expect(await getLocalChunk("cs1", 0)).toBeDefined();

        await evictChunkSet("cs1");
        expect(await getLocalChunk("cs1", 0)).toBeUndefined();
        expect(await getLocalChunkBytes()).toBe(0);
    });
});
