<script lang="ts">
import { createQuery } from "@tanstack/svelte-query";
import { treeItemsQueryOptions } from "$lib/core/data/item-queries";
import { authStore } from "$lib/core/stores/auth-store.svelte";
import { buildTree } from "$lib/core/utils/tree";
import { EmptyState, ErrorText } from "$lib/core/ui";
import FolderItem from "./FolderItem.svelte";

// Don't start decrypting tree items until the crypto worker is unlocked — the query would
// fail with "Worker not unlocked" if it fires during the startup race.
const itemsQuery = createQuery(() => ({
    ...treeItemsQueryOptions(),
    enabled: authStore.isVaultUnlocked,
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
