// The TanStack Query options for the decrypted item lists — one definition, so every observer of
// the same cache entry agrees on `staleTime`. Observers used to carry their own copies with the
// default five minutes while the layout and the folder tree said 30 s; an observer with a different
// `staleTime` treats the shared entry as stale on its own schedule and triggers extra background
// refetches (query "perf 10"). The data module is imported lazily so a page's chunk does not pull
// the decryption path in before the vault is unlocked.
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { SECOND_MS } from "$lib/core/utils/duration";
import type { DecryptedItemMeta, DeletedItemMeta } from "./items";

/** How long the decrypted tree is served from the cache before a background refetch. */
export const TREE_ITEMS_STALE_MS = 30 * SECOND_MS;
/** The trash changes right under the user's hands (restore, purge), so it goes stale sooner. */
export const DELETED_ITEMS_STALE_MS = 5 * SECOND_MS;

export function treeItemsQueryOptions() {
    return {
        queryKey: QUERY_KEYS.treeItems,
        queryFn: async (): Promise<DecryptedItemMeta[]> => {
            const { getTreeItems } = await import("./items");
            return getTreeItems();
        },
        staleTime: TREE_ITEMS_STALE_MS,
    };
}

export function deletedItemsQueryOptions() {
    return {
        queryKey: QUERY_KEYS.deletedItems,
        queryFn: async (): Promise<DeletedItemMeta[]> => {
            const { getDeletedItems } = await import("./items");
            return getDeletedItems();
        },
        staleTime: DELETED_ITEMS_STALE_MS,
    };
}
