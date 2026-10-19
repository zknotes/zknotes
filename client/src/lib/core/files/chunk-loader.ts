// Read-through loading of encrypted file chunks.
//
// It lives in `core/`, not `modules/files/`, because TWO consumers with different import rules share it:
//   • `modules/files/download.ts::decryptFile` (modules → may use core)
//   • `core/streaming/sw-bridge.ts` (core → may NOT use modules)
// For both to share the same persistence, the read-through has to live in core.
//
// `loadChunk` reads from `file-chunks` first (available offline, with no network); on a miss it fetches
// the ciphertext from the server and persists it best-effort (behind an LRU cap + a quota guard).
// Persistence is always an optimisation — a write failure never breaks the decryption.
import { getChunk } from "$lib/core/api";
import { toBase64 } from "$lib/core/utils/base64";
import {
    deleteChunkSet,
    getLocalChunk,
    getLocalChunkBytes,
    listChunkSetsByAge,
    putLocalChunk,
} from "$lib/core/db/file-chunks";
import { fileBridge } from "$lib/core/events/file-bridge";

/**
 * The upper ceiling on the `file-chunks` cache size (MB). Above it, the LRU evicts the oldest sets.
 * A conservative default (Safari/iOS drops IDB around ~1 GB even without `persist()`); a per-device
 * policy is still to come. Exposed through `.env` rather than hardcoded.
 */
const MAX_CACHE_BYTES = (Number(import.meta.env.VITE_FILE_CHUNK_CACHE_MAX_MB) || 500) * 1024 * 1024;

// The coarse LRU axis: an in-memory running total of the cache's bytes. It initialises lazily with a
// single scan, then is maintained incrementally so no full scan happens each time. The eviction
// occasionally recomputes it authoritatively from IDB (self-healing against cross-tab drift).
let runningBytes: number | null = null;

/** Resets the in-memory LRU counter after the `file-chunks` store is cleared completely. */
export function resetChunkCacheCounters(): void {
    runningBytes = null;
}

/** A test-only alias — the module-level cache survives between tests. */
export function __resetChunkCacheForTest(): void {
    resetChunkCacheCounters();
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return toBase64(digest);
}

export interface LoadChunkOptions {
    /**
     * Persist the ciphertext into the `file-chunks` IDB after a network fetch (true by default).
     * Turn it off for a one-shot export or download stream — otherwise a 2 GB file fills IDB (the
     * 500 MB cap does not evict the *current* set) and disk I/O drops from fast to a few MB/s after
     * the first third.
     */
    persist?: boolean;
}

/**
 * Loads one chunk's ciphertext — the local cache first, then the network (with persistence).
 * `nonce` (from the payload's manifest) is stored alongside the ciphertext, so the record is self-contained.
 * Returns the ciphertext bytes (the same contract as `getChunk`) — decryption is the caller's job.
 *
 * An optional `expectedHashB64` (the ciphertext's SHA-256, from the manifest) — a mismatch →
 * evict locally plus one network refetch; still a mismatch → throw.
 */
export async function loadChunk(
    chunkSetId: string,
    index: number,
    nonce: Uint8Array,
    expectedHashB64?: string,
    opts?: LoadChunkOptions,
): Promise<Uint8Array> {
    const persist = opts?.persist !== false;
    const verify = async (ct: Uint8Array): Promise<boolean> => {
        if (!expectedHashB64) return true;
        const actual = await sha256Base64(ct);
        return actual === expectedHashB64;
    };

    const local = await getLocalChunk(chunkSetId, index);
    if (local) {
        if (await verify(local.ciphertext)) return local.ciphertext;
        // A corrupt or stale cache — evict it and try the network
        await deleteChunkSet(chunkSetId).catch(() => {});
    }

    const ciphertext = await getChunk(chunkSetId, index);
    if (!(await verify(ciphertext))) {
        throw new Error(`Chunk integrity check failed (${chunkSetId}:${index})`);
    }
    if (persist) {
        // A copy on save — the caller then passes `ciphertext` on to the crypto worker; we isolate
        // the persisted buffer from any later transfer or detach.
        await persistChunk(chunkSetId, index, ciphertext.slice(), nonce.slice());
    }
    return ciphertext;
}

/** A best-effort persistence of one chunk plus the LRU enforcement. It never throws. */
async function persistChunk(
    chunkSetId: string,
    index: number,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
): Promise<void> {
    const ok = await putLocalChunk({
        key: `${chunkSetId}:${index}`,
        chunkSetId,
        index,
        ciphertext,
        nonce,
        storedAt: Date.now(),
    });
    if (!ok) return; // a quota or IDB error → a network-only fallback; the cache is left as it is
    if (runningBytes !== null) runningBytes += ciphertext.byteLength;
    await enforceCap(chunkSetId);
}

/**
 * Keeps `file-chunks` below `MAX_CACHE_BYTES` by evicting the OLDEST sets (a coarse LRU).
 * `keepChunkSetId` is the set currently being filled — it is never evicted, not even when it exceeds
 * the cap on its own: a file larger than the cap may still be cached, or it could never be offline.
 */
async function enforceCap(keepChunkSetId: string): Promise<void> {
    if (runningBytes === null) runningBytes = await getLocalChunkBytes();
    if (runningBytes <= MAX_CACHE_BYTES) return;

    // Over the cap: fetch the authoritative overview (which self-heals any drift) and evict the oldest.
    const sets = await listChunkSetsByAge();
    let total = sets.reduce((sum, s) => sum + s.bytes, 0);
    // One pinned-set computation for the whole eviction pass instead of calling
    // isPinnedChunkSet — a full recomputation — once per eviction candidate.
    const pinnedChunkSetIds = await fileBridge.getPinnedChunkSetIds?.();
    for (const set of sets) {
        if (total <= MAX_CACHE_BYTES) break;
        if (set.chunkSetId === keepChunkSetId) continue;
        if (pinnedChunkSetIds?.has(set.chunkSetId)) continue;
        total -= await deleteChunkSet(set.chunkSetId);
    }
    runningBytes = total;
}

/**
 * Evicts one chunk set from the local cache (a permanent delete, a Replace, a pull tombstone).
 * Do NOT call it on trash or restore — the file is restorable then, so the cache stays. It maintains
 * the LRU counter.
 */
export async function evictChunkSet(chunkSetId: string): Promise<void> {
    const freed = await deleteChunkSet(chunkSetId);
    if (runningBytes !== null) runningBytes = Math.max(0, runningBytes - freed);
}
