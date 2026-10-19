<script lang="ts">
import { createQuery } from "@tanstack/svelte-query";
import { Clock, FileText, Shield } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { treeItemsQueryOptions } from "$lib/core/data/item-queries";
import { folderPathLabel } from "$lib/core/data/items";
import { recentNotesStore } from "$lib/core/stores/recent-notes.svelte";
import CollectionList from "$lib/core/ui/CollectionList.svelte";
import CollectionListRow from "$lib/core/ui/CollectionListRow.svelte";
import CollectionListSkeleton from "$lib/core/ui/CollectionListSkeleton.svelte";
import { CollectionEmptyState, LocationMeta, PageHeader, UtilityCloseButton } from "$lib/core/ui";
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

const locationLabel = (parentId: string | null) => folderPathLabel(parentId, itemMap);
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
                            <LocationMeta label={path} root={!note.parent_id} />
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