/**
 * Opens the path through the sidebar tree down to `folderId` (itself included):
 * the localStorage expand + a UI signal for the FolderItems already mounted.
 */
import { pendingExpandId } from "$lib/core/stores/pending-expand.svelte";
import { expandedFolders } from "$lib/core/utils/expanded-folders";
import { collectAncestorIds } from "$lib/core/utils/tree";

export function revealFolderInTree(
    folderId: string,
    items: readonly { id: string; parent_id: string | null }[],
): void {
    const chain = collectAncestorIds(folderId, items);
    if (chain.length === 0) return;
    for (const id of chain) expandedFolders.expand(id);
    pendingExpandId.request(chain);
}
