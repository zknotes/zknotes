<script lang="ts">
import { createQuery } from "@tanstack/svelte-query";
import { Clock, CornerDownRight, FileText, Home, Shield } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { treeItemsQueryOptions } from "$lib/core/data/item-queries";
import { folderPathSegments } from "$lib/core/data/items";
import { recentNotesStore } from "$lib/core/stores/recent-notes.svelte";
import CollectionList from "$lib/core/ui/CollectionList.svelte";
import CollectionListRow from "$lib/core/ui/CollectionListRow.svelte";
import CollectionListSkeleton from "$lib/core/ui/CollectionListSkeleton.svelte";
import { CollectionEmptyState, MetaText, PageHeader, UtilityCloseButton } from "$lib/core/ui";
import { relativeTime } from "$lib/core/utils/format";

onMount(() => {
    recentNotesStore.init();
});

const itemsQuery = createQuery(() => treeItemsQueryOptions());

let itemMap = $derived.by(() => {
    const map = new Map<string, { title: string; parent_id: string | null }>();
    for (const item of itemsQuery.data ?? []) {
        map.set(item.id, { title: item.title, parent_id: item.parent_id });
    }
    return map;
});

let recentNotes = $derived.by(() => {
    const items = itemsQuery.data ?? [];
    const byId = new Map(items.map((it) => [it.id, it]));
    return recentNotesStore.ids
        .map((id) => byId.get(id))
        .filter((n): n is NonNullable<typeof n> => !!n && n.type === "note");
});

function locationLabel(parentId: string | null): string {
    const segments = folderPathSegments(parentId, itemMap);
    if (segments.length === 0) return "Home";
    return segments.map((s) => s.title).join(" / ");
}
</script>

<div class="relative flex-1 overflow-y-auto bg-[var(--surface-app)] fade-in">
    <div class="absolute top-3 right-3 z-20">
        <UtilityCloseButton />
    </div>
    <div class="max-w-6xl mx-auto px-3 sm:px-8 py-10">
        <PageHeader title="Recently opened" eyebrowClass="!text-sky-400/80">
            {#snippet eyebrow()}
                <Clock class="w-3 h-3" /> Recent · {recentNotes.length}
            {/snippet}
            {#snippet description()}
                Notes you've opened, newest first.
            {/snippet}
        </PageHeader>

        {#if itemsQuery.isLoading}
            <CollectionListSkeleton />
        {:else if recentNotes.length === 0}
            <CollectionEmptyState
                icon={Clock}
                title="No recent notes"
                subtitle="Open some notes to see them here."
            />
        {:else}
            <CollectionList>
                {#each recentNotes as note, i (note.id)}
                    {@const path = locationLabel(note.parent_id)}
                    <CollectionListRow
                        title={note.title}
                        icon={note.icon}
                        FallbackIcon={FileText}
                        onclick={() => goto(`/note/${note.id}`)}
                    >
                        {#snippet subtitle()}
                            <MetaText
                                class="flex items-center gap-1 font-mono mt-0.5 min-w-0 max-w-full truncate"
                                title={path}
                            >
                                {#if note.parent_id}
                                    <CornerDownRight class="w-[0.625rem] h-[0.625rem] flex-shrink-0" />
                                {:else}
                                    <Home class="w-[0.625rem] h-[0.625rem] flex-shrink-0" />
                                {/if}
                                <span class="truncate">{path}</span>
                            </MetaText>
                        {/snippet}
                        {#snippet trailing()}
                            <span class="text-xs font-mono text-[var(--text-dim)] shrink-0">
                                #{i + 1} · {relativeTime(note.updated_at)}
                            </span>
                            <span class="text-brand-fg/70 shrink-0"><Shield class="w-[0.6875rem] h-[0.6875rem]" /></span>
                        {/snippet}
                    </CollectionListRow>
                {/each}
            </CollectionList>
        {/if}
    </div>
</div>