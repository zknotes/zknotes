import { getDB } from "$lib/core/db";
import { deleteChunkSet, listChunkSetsByAge } from "$lib/core/db/file-chunks";
import { emitFilesChanged } from "$lib/modules/files/files-changed-bus";
import { buildPinnedItemSet } from "./pin-orchestrator";

export async function clearUnpinnedCache(): Promise<number> {
    const db = await getDB();
    const items = await db.getAll("items");
    const pinnedItems = await buildPinnedItemSet();
    const pinnedChunkSets = new Set<string>();

    // Find all chunk_set_ids that belong to pinned items
    for (const item of items) {
        if (pinnedItems.has(item.id) && item.chunk_set_id) {
            pinnedChunkSets.add(item.chunk_set_id);
        }
    }

    const chunkSets = await listChunkSetsByAge();
    let freedBytes = 0;
    const affectedItemIds = new Set<string>();

    for (const cs of chunkSets) {
        if (!pinnedChunkSets.has(cs.chunkSetId)) {
            freedBytes += await deleteChunkSet(cs.chunkSetId);

            // Find every item with this chunkSetId and emit the change (so the presence badge falls back to the cloud)
            for (const item of items) {
                if (item.chunk_set_id === cs.chunkSetId) {
                    affectedItemIds.add(item.id);
                }
            }
        }
    }

    if (affectedItemIds.size > 0) {
        emitFilesChanged(Array.from(affectedItemIds));
    }

    return freedBytes;
}
