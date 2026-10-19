<script lang="ts">
import { createQuery, useQueryClient } from "@tanstack/svelte-query";
import { CornerDownRight, FileText, Home, Shield, Star } from "lucide-svelte";
import { goto } from "$app/navigation";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { treeItemsQueryOptions } from "$lib/core/data/item-queries";
import { folderPathSegments } from "$lib/core/data/items";
import { ItemService } from "$lib/core/services/item-service";
import Button from "$lib/core/ui/Button.svelte";
import { CollectionEmptyState, PageHeader, UtilityCloseButton } from "$lib/core/ui";
import CollectionList from "$lib/core/ui/CollectionList.svelte";
import CollectionListRow from "$lib/core/ui/CollectionListRow.svelte";
import CollectionListSkeleton from "$lib/core/ui/CollectionListSkeleton.svelte";
import { relativeTime } from "$lib/core/utils/format";

const queryClient = useQueryClient();

const itemsQuery = createQuery(() => treeItemsQueryOptions());

let itemMap = $derived.by(() => {
    const map = new Map<string, { title: string; parent_id: string | null }>();
    for (const item of itemsQuery.data ?? []) {
        map.set(item.id, { title: item.title, parent_id: item.parent_id });
    }
    return map;
});

let starredNotes = $derived(
    (itemsQuery.data ?? [])
        .filter((i) => i.type === "note" && i.starred)
        .sort((a, b) => b.updated_at - a.updated_at),
);

function locationLabel(parentId: string | null): string {
    const segments = folderPathSegments(parentId, itemMap);
    if (segments.length === 0) return "Home";
    return segments.map((s) => s.title).join(" / ");
}

async function unstar(id: string) {
    await ItemService.updateItemStarred(id, false);
    await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
}
</script>

<div class="relative flex-1 overflow-y-auto bg-[var(--surface-app)] fade-in">
    <div class="absolute top-3 right-3 z-20">
        <UtilityCloseButton />
    </div>
    <div class="max-w-6xl mx-auto px-3 sm:px-8 py-10">
        <PageHeader title="Starred notes" eyebrowClass="!text-amber-400/80">
            {#snippet eyebrow()}
                <Star class="w-[0.6875rem] h-[0.6875rem] fill-current" /> Starred · {starredNotes.length}
            {/snippet}
            {#snippet description()}
                Quick access to the notes you flagged as important.
            {/snippet}
        </PageHeader>

        {#if itemsQuery.isLoading}
            <CollectionListSkeleton />
        {:else if starredNotes.length === 0}
            <CollectionEmptyState
                icon={Star}
                title="No starred notes yet"
                subtitle="Open a note and tap the star in the top bar to pin it here."
            />
        {:else}
            <CollectionList>
                {#each starredNotes as note (note.id)}
                    {@const path = locationLabel(note.parent_id)}
                    <CollectionListRow
                        title={note.title}
                        icon={note.icon}
                        FallbackIcon={FileText}
                        onclick={() => goto(`/note/${note.id}`)}
                    >
                        {#snippet subtitle()}
                            <div
                                class="flex items-center gap-1 text-2xs font-mono text-[var(--text-dim)] mt-0.5 min-w-0 max-w-full truncate"
                                title={path}
                            >
                                {#if note.parent_id}
                                    <CornerDownRight class="w-[0.625rem] h-[0.625rem] flex-shrink-0" />
                                {:else}
                                    <Home class="w-[0.625rem] h-[0.625rem] flex-shrink-0" />
                                {/if}
                                <span class="truncate">{path}</span>
                            </div>
                        {/snippet}
                        {#snippet trailing()}
                            <span class="text-xs font-mono text-[var(--text-dim)]">{relativeTime(note.updated_at)}</span>
                            <span class="text-brand-fg/70"><Shield class="w-[0.6875rem] h-[0.6875rem]" /></span>
                        {/snippet}
                        {#snippet actions()}
                            <Button
                                variant="ghost"
                                size="icon"
                                onclick={() => unstar(note.id)}
                                title="Remove star"
                                class="w-6 h-6 !text-amber-400 hover:!bg-amber-400/10"
                            >
                                <Star class="w-3 h-3 fill-current" />
                            </Button>
                        {/snippet}
                    </CollectionListRow>
                {/each}
            </CollectionList>
        {/if}
    </div>
</div>