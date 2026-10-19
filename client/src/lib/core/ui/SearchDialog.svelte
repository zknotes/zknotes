<script lang="ts">
import { useQueryClient } from "@tanstack/svelte-query";
import { Clock, FileText, Folder, Paperclip, Plus, Search, Shield, Zap } from "lucide-svelte";
import { tick } from "svelte";
import { goto } from "$app/navigation";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import type { LucideIcon } from "$lib/core/types/icons";
import { groupByType, highlightSegments, type RankedHit, searchItems } from "$lib/core/search";
import { ItemService } from "$lib/core/services/item-service";
import { activeSidebarId } from "$lib/core/stores/active-sidebar-id.svelte";
import { pendingRenameId } from "$lib/core/stores/pending-rename.svelte";
import {
    createSearchListState,
    type SearchListState,
} from "$lib/core/stores/search-list-state.svelte";
import { searchIndexStore } from "$lib/core/stores/search-index.svelte";
import { searchOpenStore } from "$lib/core/stores/search-open.svelte";
import { expandedFolders } from "$lib/core/utils/expanded-folders";
import { buildParentPathFrom } from "$lib/core/utils/tree";
import { Button, ItemTitle, EmptyState, Eyebrow, Kbd, MetaText } from "$lib/core/ui";

const RESULT_LIMIT = 8;

const SECTION_ICONS: Record<string, LucideIcon> = {
    recent: Clock,
    note: FileText,
    folder: Folder,
    file: Paperclip,
};

const queryClient = useQueryClient();

let dialogEl = $state<HTMLDialogElement | null>(null);
let inputEl = $state<HTMLInputElement | null>(null);

// Indexed once per search rather than once per rendered row — the palette resolves a path and an
// icon for every hit, and the vault can hold a great many items.
let itemsById = $state<ReadonlyMap<string, DecryptedItemMeta>>(new Map());

const list: SearchListState<RankedHit> = createSearchListState<RankedHit>({
    search: (q) => {
        const items = queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems) ?? [];
        itemsById = new Map(items.map((item) => [item.id, item]));
        return searchItems(q, items, RESULT_LIMIT);
    },
    // The "New note" action row exists as soon as there is a query
    extraRows: () => actionRows,
    onEnter: (sel) => {
        if (actionRows > 0 && sel === 0) {
            createNote();
            return;
        }
        const hit = rows[sel - actionRows];
        if (hit) open(hit);
    },
    onEscape: () => searchOpenStore.hide(),
});

const actionRows = $derived(list.query.trim() ? 1 : 0);

interface PaletteSection {
    key: string;
    label: string;
    icon: LucideIcon;
    rows: Array<{ hit: RankedHit; index: number }>;
}

/**
 * Before anything is typed the palette lists the recent items; once there is a query the hits are
 * grouped per type, in the order the ranking produced — so the strongest match is always the row
 * right below the action.
 */
const sections = $derived.by<PaletteSection[]>(() => {
    const groups = list.query.trim()
        ? groupByType(list.results).map((group) => ({
              key: group.kind,
              label: group.label,
              hits: group.hits,
          }))
        : list.results.length > 0
          ? [{ key: "recent", label: "Recent", hits: list.results }]
          : [];

    let index = 0;
    return groups.map((group) => ({
        key: group.key,
        label: group.label,
        icon: SECTION_ICONS[group.key] ?? FileText,
        rows: group.hits.map((hit) => ({ hit, index: index++ })),
    }));
});

/** The hits in rendered order — the selection index counts these, not list.results. */
const rows = $derived(sections.flatMap((section) => section.rows.map((row) => row.hit)));

$effect(() => {
    if (!dialogEl) return;
    if (searchOpenStore.open) {
        dialogEl.showModal();
        list.reset();
        // Off the effect's synchronous scope on purpose: list.run() reads the query, and a tracked
        // read here would re-run this effect — and reset the dialog — on every keystroke.
        tick().then(() => {
            inputEl?.focus();
            list.run();
        });
    } else {
        if (dialogEl.open) dialogEl.close();
    }
});

async function open(hit: RankedHit) {
    searchOpenStore.hide();
    if (hit.type === "note") {
        activeSidebarId.set(hit.id);
        await goto(`/note/${hit.id}`, { keepFocus: true });
    } else {
        expandedFolders.expand(hit.id);
        activeSidebarId.set(hit.id);
    }
}

async function createNote() {
    searchOpenStore.hide();
    try {
        const item = await ItemService.createItem("note", null, list.query.trim() || "Untitled");
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        await goto(`/note/${item.id}`, { keepFocus: true });
        pendingRenameId.set(item.id);
    } catch (e) {
        console.error("Failed to create note from search", e);
    }
}

function onWindowKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchOpenStore.show();
    }
}

function onDialogClick(e: MouseEvent) {
    if (e.target === dialogEl) searchOpenStore.hide();
}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet sectionHeader(label: string, Icon: LucideIcon)}
    <Eyebrow class="flex items-center gap-1.5 px-4 pt-2.5 pb-1 select-none">
        <Icon class="w-[0.625rem] h-[0.625rem] shrink-0" />
        {label}
    </Eyebrow>
{/snippet}

<dialog
    bind:this={dialogEl}
    oncancel={(e) => { e.preventDefault(); searchOpenStore.hide(); }}
    onclick={onDialogClick}
    class="hidden open:flex m-auto mt-4 md:mt-[18vh] w-[580px] max-w-[calc(100vw-2rem)] max-h-[85vh] flex-col
           bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-xl
           shadow-[var(--float-shadow)] overflow-hidden p-0
           backdrop:bg-black/60 backdrop:backdrop-blur-sm"
>
    <!-- The input row -->
    <div class="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--stroke)] shrink-0">
        <Search class="w-[0.875rem] h-[0.875rem] text-[var(--text-dim)] shrink-0" />
        <input
            bind:this={inputEl}
            bind:value={list.query}
            oninput={() => list.onInput()}
            onkeydown={(e) => list.onKeydown(e)}
            placeholder={searchIndexStore.isReady ? "Search notes, folders…" : "Building search index…"}
            disabled={!searchIndexStore.isReady}
            class="input flex-1 border-0 bg-transparent shadow-none rounded-none px-0 py-0 text-sm focus:shadow-none"
        />
        <Kbd class="shrink-0 !text-2xs px-1.5 py-0.5">esc</Kbd>
    </div>

    <!-- Results -->
    <div class="py-1 flex-1 min-h-0 overflow-y-auto">
        <!-- "New note" action when there's a query -->
        {#if actionRows > 0}
            {@render sectionHeader("Actions", Zap)}
            <Button
                variant="ghost"
                active={list.sel === 0}
                onclick={createNote}
                onmouseenter={() => list.sel = 0}
                class="w-full !h-auto !justify-start gap-2.5 !px-4 !py-2.5 text-left rounded-none"
            >
                <span class="w-5 h-5 rounded bg-brand0/15 flex items-center justify-center text-brand-fg shrink-0">
                    <Plus class="w-3 h-3" />
                </span>
                <span class="text-sm text-brand-fg">New note: <span class="text-[var(--text-sub)]">"{list.query.trim()}"</span></span>
                <Kbd class="ml-auto !text-2xs px-1 py-0.5">↵</Kbd>
            </Button>
        {/if}

        <!-- Search results, grouped -->
        {#each sections as section (section.key)}
            {@render sectionHeader(section.label, section.icon)}
            {#each section.rows as { hit, index } (hit.id)}
                {@const rowSel = index + actionRows}
                {@const path = buildParentPathFrom(hit.id, itemsById)}
                {@const icon = itemsById.get(hit.id)?.icon}
                <Button
                    variant="ghost"
                    active={list.sel === rowSel}
                    onclick={() => open(hit)}
                    onmouseenter={() => list.sel = rowSel}
                    class="w-full !h-auto !justify-start gap-2.5 !px-4 !py-2.5 text-left rounded-none"
                >
                    <span class="shrink-0 flex items-center justify-center w-[0.8125rem] h-[0.8125rem]
                                 {hit.type === 'folder' ? 'text-brand-fg' : 'text-[var(--text-dim)]'}">
                        {#if icon}
                            <span class="emoji-icon text-xs">{icon}</span>
                        {:else if hit.type === "folder"}
                            <Folder class="w-[0.8125rem] h-[0.8125rem]" />
                        {:else}
                            <FileText class="w-[0.8125rem] h-[0.8125rem]" />
                        {/if}
                    </span>
                    <ItemTitle class="flex-1 truncate !font-normal">
                        {#each highlightSegments(hit.title, hit.positions) as segment}
                            {#if segment.hit}<mark class="bg-transparent text-brand-fg font-semibold">{segment.text}</mark>{:else}{segment.text}{/if}
                        {/each}
                    </ItemTitle>
                    {#if hit.contentOnly}
                        <MetaText class="!text-2xs font-mono shrink-0">in text</MetaText>
                    {/if}
                    {#if path}
                        <span class="text-2xs font-mono text-[var(--text-dim)] truncate max-w-[140px] shrink-0">{path}</span>
                    {/if}
                </Button>
            {/each}
        {/each}

        <!-- Empty states -->
        {#if rows.length === 0 && !list.query.trim()}
            <EmptyState class="px-4 py-8 text-center font-mono">type to search…</EmptyState>
        {:else if rows.length === 0}
            <EmptyState class="px-4 py-4 text-center font-mono">
                no matches · press <Kbd class="px-1 py-0 !text-2xs">↵</Kbd> to create
            </EmptyState>
        {/if}
    </div>

    <!-- Footer hints -->
    <div class="px-4 py-2 border-t border-[var(--stroke)] bg-[var(--surface-app)] flex items-center gap-3 text-2xs font-mono text-[var(--text-dim)] shrink-0">
        <span class="flex items-center gap-1">
            <Kbd class="px-1 py-0 !text-2xs">↑↓</Kbd> navigate
        </span>
        <span class="flex items-center gap-1">
            <Kbd class="px-1 py-0 !text-2xs">↵</Kbd> open
        </span>
        <span class="flex items-center gap-1">
            <Kbd class="px-1 py-0 !text-2xs">esc</Kbd> close
        </span>
        <span class="hidden sm:flex items-center gap-1.5 ml-auto">
            <Shield class="w-[0.625rem] h-[0.625rem]" /> end-to-end encrypted
        </span>
    </div>
</dialog>
