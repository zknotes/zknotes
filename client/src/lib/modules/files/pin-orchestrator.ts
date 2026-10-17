import { getDB, type LocalItem } from "$lib/core/db";
import { hasAllChunks } from "$lib/core/db/file-chunks";
import { evictChunkSet, loadChunk } from "$lib/core/files/chunk-loader";
import { getPinnedRoots, pinManager } from "$lib/core/files/pin-manager-state.svelte";
import { fromBase64 } from "$lib/core/utils/base64";
import { getFilePayload } from "./download";
import { emitFilesChanged } from "./files-changed-bus";

/**
 * The parent chain for a pin: folder → note → file (a file's 1:1 parent is always a note).
 * Without `note` in the map the file→note walk stops and pinning a folder misses the attachments.
 */
function buildParentMap(
    items: Array<{ id: string; type: string; parent_id: string | null }>,
): Map<string, string | null> {
    const parentMap = new Map<string, string | null>();
    for (const item of items) {
        if (item.type === "folder" || item.type === "file" || item.type === "note") {
            parentMap.set(item.id, item.parent_id);
        }
    }
    return parentMap;
}

/**
 * Asynchronously builds the Set of every item ID — files, notes and folders — covered by pinning,
 * resolving the tree (parent_id) up to the root and detecting cycles along the way.
 * An O(1) check during a download or a sync.
 *
 * `preFetchedItems`, when given, is used instead of a fresh `getAll("items")` (query "perf 14") — a
 * caller that already has one in hand (isPinnedChunkSet, freeUnpinnedTree) does not need a second
 * full-table scan.
 */
export async function buildPinnedItemSet(preFetchedItems?: LocalItem[]): Promise<Set<string>> {
    const db = await getDB();
    const items = preFetchedItems ?? (await db.getAll("items"));
    const parentMap = buildParentMap(items);

    // A Set instead of an array (query "perf 14"): `.has()` is O(1), not O(pinnedRoots.length) per
    // ancestor hop of every item in the vault.
    const pinnedRoots = new Set(getPinnedRoots());
    const pinnedSet = new Set<string>();

    for (const item of items) {
        let currentId: string | null = item.id;
        const visited = new Set<string>();
        while (currentId !== null) {
            if (visited.has(currentId)) break;
            visited.add(currentId);

            if (pinnedRoots.has(currentId)) {
                pinnedSet.add(item.id);
                break;
            }
            currentId = parentMap.get(currentId) ?? null;
        }
    }

    return pinnedSet;
}

/**
 * The chunk_set_id of every currently-pinned file, in one pass (query "perf 14") — the batched
 * counterpart to calling isPinnedChunkSet once per candidate (chunk-loader.ts's enforceCap used to).
 */
export async function buildPinnedChunkSetIds(preFetchedItems?: LocalItem[]): Promise<Set<string>> {
    const db = await getDB();
    const items = preFetchedItems ?? (await db.getAll("items"));
    const pinnedSet = await buildPinnedItemSet(items);

    const chunkSetIds = new Set<string>();
    for (const item of items) {
        if (item.type === "file" && item.chunk_set_id && pinnedSet.has(item.id)) {
            chunkSetIds.add(item.chunk_set_id);
        }
    }
    return chunkSetIds;
}

/** True when the given chunkSetId belongs to any pinned file. */
export async function isPinnedChunkSet(chunkSetId: string): Promise<boolean> {
    const pinnedChunkSetIds = await buildPinnedChunkSetIds();
    return pinnedChunkSetIds.has(chunkSetId);
}

/**
 * Called AFTER a successful pullAndMerge(), and after an explicit pin.
 * For every pinned file it checks whether all the chunks are present, decrypts the metadata and
 * fetches the ciphertext for every chunk in the background.
 */
export async function syncPinnedChunks(): Promise<void> {
    const pinnedSet = await buildPinnedItemSet();
    const db = await getDB();

    for (const itemId of pinnedSet) {
        const item = await db.get("items", itemId);
        if (item && item.type === "file" && item.chunk_set_id && item.chunk_count) {
            // Check whether a load is needed at all (an optimisation: decryptItemPayload is skipped when it is local)
            const isLocal = await hasAllChunks(item.chunk_set_id, item.chunk_count);
            if (!isLocal) {
                try {
                    // Decrypt the payload only to reach the chunk nonces
                    const payload = await getFilePayload(itemId);
                    if (payload && payload.kind === "file" && payload.chunkSetId) {
                        for (let i = 0; i < payload.chunks.length; i++) {
                            const nonce = fromBase64(payload.chunks[i].nonce);
                            // loadChunk will try the network when it is missing, and persist it
                            await loadChunk(payload.chunkSetId, i, nonce);
                        }
                        emitFilesChanged([itemId]);
                    }
                } catch (e) {
                    console.warn(`Failed to background sync chunks for pinned file ${itemId}:`, e);
                }
            }
        }
    }
}

/**
 * Explicitly deletes the cached chunks of one file (Free up space)
 * whether it was pinned or merely auto-downloaded.
 */
export async function freeLocalFile(itemId: string): Promise<void> {
    const db = await getDB();
    const item = await db.get("items", itemId);
    if (item && item.type === "file" && item.chunk_set_id) {
        await evictChunkSet(item.chunk_set_id);
        emitFilesChanged([itemId]);
    }
}

/**
 * Internally: on an unpin it frees the chunks of the whole subtree that is no longer covered by
 * any pin.
 */
async function freeUnpinnedTree(unpinnedId: string): Promise<void> {
    const db = await getDB();
    const items = await db.getAll("items");
    const parentMap = buildParentMap(items);

    // Which items are in the unpinned one's subtree?
    const subtree = new Set<string>([unpinnedId]);
    for (const item of items) {
        let currentId: string | null = item.id;
        const visited = new Set<string>();
        while (currentId !== null) {
            if (visited.has(currentId)) break;
            visited.add(currentId);

            if (subtree.has(currentId)) {
                subtree.add(item.id);
                break;
            }
            currentId = parentMap.get(currentId) ?? null;
        }
    }

    // Which items REMAINED pinned globally? (reuses the `items` snapshot already in hand above)
    const stillPinned = await buildPinnedItemSet(items);

    for (const itemId of subtree) {
        if (!stillPinned.has(itemId)) {
            const item = await db.get("items", itemId);
            if (item && item.type === "file" && item.chunk_set_id) {
                await evictChunkSet(item.chunk_set_id);
                emitFilesChanged([itemId]);
            }
        }
    }
}

// === Decoration / wrapper ===
// This ensures pinManager (core state) keeps its full behaviour, side effects included, even when
// core/ui/FolderItem calls it directly. Modules may import core.
// The wrapper is applied when this module is imported (which register-bridge.ts triggers).

const origPinItem = pinManager.pinItem.bind(pinManager);
pinManager.pinItem = (id: string): void => {
    origPinItem(id);
    syncPinnedChunks().catch(console.error);
    emitFilesChanged([id]);
};

const origUnpinItem = pinManager.unpinItem.bind(pinManager);
pinManager.unpinItem = (id: string): void => {
    origUnpinItem(id);
    emitFilesChanged([id]);
    freeUnpinnedTree(id).catch(console.error);
};

// Register syncPinnedChunks through the bridge so core/sync/pull.ts can call it
// without importing modules/*.
import { registerSyncPinnedChunks } from "$lib/core/events/file-bridge";

registerSyncPinnedChunks(syncPinnedChunks);
