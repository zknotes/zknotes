// The persistent cache of encrypted file chunks.
//
// The zero-knowledge invariant: this store holds ciphertext ONLY (exactly like
// `items.encrypted_payload`). Decrypted plaintext never enters it — that lives solely in the RAM
// `blob-cache` and is cleared on lock or logout. Clearing this cache ("Free up space")
// is safe, because the server is always the source.
//
// Every enumeration goes through a cursor (one record in memory at a time), never `getAll` — a single
// chunk can be up to ~5 MiB, so a `getAll` over a whole set would pull tens of MB into RAM for nothing.
import { getDB, type LocalChunk } from "./index";

/** One chunk's composite key — `${chunkSetId}:${index}`. */
export function chunkKey(chunkSetId: string, index: number): string {
    return `${chunkSetId}:${index}`;
}

/** Fetches one chunk's cached ciphertext, or `undefined` on a miss. */
export async function getLocalChunk(
    chunkSetId: string,
    index: number,
): Promise<LocalChunk | undefined> {
    const db = await getDB();
    return db.get("file-chunks", chunkKey(chunkSetId, index));
}

/**
 * Persists one chunk. It returns `true` on success and `false` when the write fails (a
 * `QuotaExceededError`) — persistence is an optimisation and never a condition of correctness, so on
 * a `false` the caller simply carries on network-only.
 */
export async function putLocalChunk(record: LocalChunk): Promise<boolean> {
    try {
        const db = await getDB();
        await db.put("file-chunks", record);
        return true;
    } catch (e) {
        // A QuotaExceededError, or any IDB write error → a graceful fallback.
        console.warn(`[file-chunks] putLocalChunk failed for ${record.key}`, e);
        return false;
    }
}

/**
 * Whether every chunk of a set is present locally (the source of truth for the presence badge).
 * Every index 0..count-1 has to exist — the number of rows alone is not enough
 * ({0,1,99} with count=3 would otherwise pass).
 */
export async function hasAllChunks(chunkSetId: string, count: number): Promise<boolean> {
    if (count <= 0) return false;
    const db = await getDB();
    for (let i = 0; i < count; i++) {
        const row = await db.get("file-chunks", chunkKey(chunkSetId, i));
        if (!row) return false;
    }
    return true;
}

/**
 * Deletes every chunk of one set and returns the bytes freed. It is called on a permanent delete or
 * a Replace / a pull tombstone — NEVER on a trash/restore (the file can come back).
 */
export async function deleteChunkSet(chunkSetId: string): Promise<number> {
    const db = await getDB();
    const tx = db.transaction("file-chunks", "readwrite");
    const index = tx.store.index("by-chunk-set");
    let freed = 0;
    let cursor = await index.openCursor(IDBKeyRange.only(chunkSetId));
    while (cursor) {
        freed += cursor.value.ciphertext.byteLength;
        await cursor.delete();
        cursor = await cursor.continue();
    }
    await tx.done;
    return freed;
}

/**
 * Clears the whole `file-chunks` store (a logout or a user switch).
 * It returns the number of bytes freed, measured before the clear.
 */
export async function clearAllLocalChunks(): Promise<number> {
    const bytes = await getLocalChunkBytes();
    const db = await getDB();
    await db.clear("file-chunks");
    return bytes;
}

/** The total ciphertext bytes in the cache (for the storage manager and the cap enforcement). */
export async function getLocalChunkBytes(): Promise<number> {
    const db = await getDB();
    const tx = db.transaction("file-chunks", "readonly");
    let total = 0;
    let cursor = await tx.store.openCursor();
    while (cursor) {
        total += cursor.value.ciphertext.byteLength;
        cursor = await cursor.continue();
    }
    await tx.done;
    return total;
}

/** A summary of one cached chunk set (for the LRU eviction). */
export interface ChunkSetSummary {
    chunkSetId: string;
    bytes: number;
    /** The oldest `storedAt` in the set — a rough LRU axis, and rough is enough. */
    oldestStoredAt: number;
}

/**
 * Every cached chunk set, sorted oldest to newest by `oldestStoredAt`.
 * The LRU eviction uses it to pick candidates once the cache passes its cap.
 */
export async function listChunkSetsByAge(): Promise<ChunkSetSummary[]> {
    const db = await getDB();
    const tx = db.transaction("file-chunks", "readonly");
    const groups = new Map<string, ChunkSetSummary>();
    let cursor = await tx.store.openCursor();
    while (cursor) {
        const { chunkSetId, ciphertext, storedAt } = cursor.value;
        const g = groups.get(chunkSetId);
        if (g) {
            g.bytes += ciphertext.byteLength;
            if (storedAt < g.oldestStoredAt) g.oldestStoredAt = storedAt;
        } else {
            groups.set(chunkSetId, {
                chunkSetId,
                bytes: ciphertext.byteLength,
                oldestStoredAt: storedAt,
            });
        }
        cursor = await cursor.continue();
    }
    await tx.done;
    return [...groups.values()].sort((a, b) => a.oldestStoredAt - b.oldestStoredAt);
}
