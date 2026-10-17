<script lang="ts">
import { createQuery } from "@tanstack/svelte-query";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { getTreeItems } from "$lib/core/data/items";
import { authStore } from "$lib/core/stores/auth-store.svelte";
import { SECOND_MS } from "$lib/core/utils/duration";
import { buildTree } from "$lib/core/utils/tree";
import { EmptyState, ErrorText } from "$lib/core/ui";
import FolderItem from "./FolderItem.svelte";

// Don't start decrypting tree items until the crypto worker is unlocked — the query would
// fail with "Worker not unlocked" if it fires during the startup race.
const itemsQuery = createQuery(() => ({
    queryKey: QUERY_KEYS.treeItems,
    queryFn: getTreeItems,
    enabled: authStore.isVaultUnlocked,
    // Matches (app)/+layout.svelte's own copy of this query (query "perf 10") — without it, this
    // observer treats the shared cache entry as always-stale and can trigger its own background
    // refetch on every mount/focus even when the layout's copy would not have.
    staleTime: 30 * SECOND_MS,
}));

let tree = $derived(buildTree(itemsQuery.data ?? []));
</script>

{#if itemsQuery.isLoading}
    <div class="px-2 space-y-1.5">
        {#each Array(5) as _}
            <div class="w-full h-5 bg-[var(--surface-raised)] rounded-md animate-pulse"></div>
        {/each}
    </div>
{:else if itemsQuery.isError}
    <ErrorText class="px-3 py-6 text-center font-mono">Failed to load tree.</ErrorText>
{:else}
    <!-- data-testid="folder-tree" sits on the scroll container in (app)/+layout.svelte — the full
         width of the sidebar, not just shrink-wrapped content. -->
    <div class="w-full">
        {#each tree as node (node.id)}
            <FolderItem node={node} level={0} />
        {/each}
        {#if tree.length === 0}
            <EmptyState class="px-3 py-6 text-center font-mono">your vault is empty</EmptyState>
        {/if}
    </div>
{/if}
