<script lang="ts">
import { useQueryClient } from "@tanstack/svelte-query";
import { FileText, Search } from "lucide-svelte";
import { tick } from "svelte";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import { search } from "$lib/core/search";
import {
    createSearchListState,
    type SearchListState,
} from "$lib/core/stores/search-list-state.svelte";
import { ItemTitle, MetaText } from "$lib/core/ui";
import { buildParentPath } from "$lib/core/utils/tree";
import type { SearchHit } from "$lib/core/workers/crypto-rpc";

interface Props {
    title?: string;
    excludedNoteId?: string;
    onSelect: (noteId: string) => void | Promise<void>;
    onClose: () => void;
}
const { title = "Select destination note", excludedNoteId, onSelect, onClose }: Props = $props();

// While a selection is in flight (a move between notes, say — an async decrypt/re-encrypt), the
// dialog stays open rather than disappearing before the operation has actually finished (otherwise the
// user, or a test, can navigate on while the fire-and-forget mutation is still in the air — see the
// 04-files-in-notes E2E).
let selecting = $state(false);

const queryClient = useQueryClient();

let dialogEl = $state<HTMLDialogElement | null>(null);
let inputEl = $state<HTMLInputElement | null>(null);

const list: SearchListState<SearchHit> = createSearchListState<SearchHit>({
    search: async (q) => {
        // An empty query: fall back to the first 8 notes in the tree (search() demands a query)
        if (!q.trim()) {
            const items = queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems) ?? [];
            return items
                .filter((i) => i.type === "note" && i.id !== excludedNoteId)
                .slice(0, 8)
                .map((i) => ({
                    id: i.id,
                    type: "note" as const,
                    title: i.title,
                    contentPreview: "",
                    score: 0,
                }));
        }
        const hits = await search(q, 20);
        return hits.filter((h) => h.type === "note" && h.id !== excludedNoteId).slice(0, 8);
    },
    onEnter: (sel) => {
        const hit = list.results[sel];
        if (hit) selectNote(hit.id);
    },
    onEscape: () => onClose(),
});

$effect(() => {
    if (dialogEl && !dialogEl.open) {
        dialogEl.showModal();
        list.reset();
        list.run();
        tick().then(() => inputEl?.focus());
    }
});

function getPath(id: string): string {
    const items = queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems) ?? [];
    return buildParentPath(id, items) || "Vault";
}

async function selectNote(noteId: string) {
    if (selecting) return;
    selecting = true;
    try {
        await onSelect(noteId);
    } finally {
        selecting = false;
    }
    dialogEl?.close();
}
</script>

<dialog
    bind:this={dialogEl}
    onclose={onClose}
    onclick={(e) => {
        if (e.target === dialogEl) onClose();
    }}
    class="backdrop:bg-black/60 bg-[var(--surface-app)] border border-[var(--stroke)] rounded-xl shadow-2xl p-0 w-full max-w-lg m-auto overflow-hidden fixed top-[15vh] mb-auto fade-in outline-none"
>
    <div class="px-4 py-3 border-b border-[var(--stroke)] bg-[var(--surface-panel)] flex items-center gap-3">
        <Search class="w-5 h-5 text-[var(--text-dim)]" />
        <input
            bind:this={inputEl}
            bind:value={list.query}
            oninput={() => list.onInput()}
            onkeydown={(e) => list.onKeydown(e)}
            type="text"
            placeholder={title}
            class="w-full bg-transparent border-none text-sm text-[var(--text)] focus:outline-none focus:ring-0 p-0 placeholder:text-[var(--text-dim)]"
        />
    </div>

    <div class="py-2 max-h-[60vh] overflow-y-auto">
        {#each list.results as hit, i (hit.id)}
            {@const path = getPath(hit.id)}
            <!-- svelte-ignore a11y_interactive_supports_focus -->
            <div
                role="button"
                onmousedown={(e) => {
                    e.preventDefault(); // keep focus on input
                    selectNote(hit.id);
                }}
                onmouseenter={() => (list.sel = i)}
                class="w-full flex flex-col gap-1 px-4 py-3 cursor-pointer select-none transition-colors {i === list.sel
                    ? 'bg-brand0/10'
                    : 'hover:bg-[var(--row-hover)]/50'}"
            >
                <div class="flex items-center justify-between text-sm">
                    <div class="flex items-center gap-2 {i === list.sel ? 'text-brand-fg' : 'text-[var(--text-sub)]'}">
                        <FileText class="w-[0.875rem] h-[0.875rem] shrink-0" />
                        <ItemTitle>{hit.title || "Untitled"}</ItemTitle>
                    </div>
                </div>
                <MetaText as="div" class="pl-[22px] truncate">{path}</MetaText>
            </div>
        {/each}

        {#if list.results.length === 0}
            <div class="px-4 py-6 text-center text-sm text-[var(--text-dim)]">No matching notes found.</div>
        {/if}
    </div>
</dialog>

<style>
    dialog::backdrop {
        backdrop-filter: blur(2px);
    }
</style>
