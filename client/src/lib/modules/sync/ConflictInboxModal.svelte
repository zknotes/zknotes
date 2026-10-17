<script lang="ts">
import { onMount } from "svelte";
import { Check, ArrowLeftRight, FileText, Image } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import Dialog from "$lib/core/ui/Dialog.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";
import { Eyebrow, MetaText, ItemTitle, EmptyState } from "$lib/core/ui";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { getDB } from "$lib/core/db";
import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import { resolveConflictInDB } from "$lib/core/sync/conflict";
import { pushPendingMutations } from "$lib/core/sync/engine";
import { sanitizeHtml, escapeHtml } from "$lib/core/utils/dompurify";
import { formatDate } from "$lib/core/utils/format";
import { extractPlainText } from "$lib/core/utils/tiptap-text";

const { onClose }: { onClose: () => void } = $props();

let selectedId = $state<string | null>(null);

// Refresh the list from IDB every time the modal opens — the store is only filled when the sync engine
// detects a new conflict (add()), so it can be stale on a reopen.
onMount(() => void conflictStore.loadAllConflicts());
let resolving = $state(false);

let localHtml = $state<string | null>(null);
let serverHtml = $state<string | null>(null);
let localEmpty = $state(true);
let serverEmpty = $state(true);
let loadingPayloads = $state(false);

// Rendering the TipTap content: an HTML string → sanitised; a JSON tree → escaped plaintext
// (we have no editor instance for rendering JSON inside the modal).
function renderContent(content: unknown): string {
    if (typeof content === "string") return sanitizeHtml(content);
    if (content && typeof content === "object") return escapeHtml(extractPlainText(content));
    return "";
}

let selectedConflict = $derived(
    conflictStore.allConflicts.find((c) => c.id === selectedId) || conflictStore.allConflicts[0],
);

$effect(() => {
    if (conflictStore.allConflicts.length > 0) {
        if (selectedId === null || !conflictStore.allConflicts.some((c) => c.id === selectedId)) {
            selectedId = conflictStore.allConflicts[0].id;
        }
    } else if (conflictStore.allConflicts.length === 0 && selectedId !== null) {
        // Close automatically only if selectedId had already been set — which means we had data and
        // the user has resolved all of it. Without this check the modal would close immediately on a
        // remount whenever allConflicts had not yet been filled from IDB (a timing race).
        onClose();
    }
});

$effect(() => {
    if (selectedConflict) {
        loadPayloads(selectedConflict.id, selectedConflict.conflict_of);
    } else {
        localHtml = null;
        serverHtml = null;
        localEmpty = true;
        serverEmpty = true;
    }
});

async function loadPayloads(conflictId: string, originalId: string | undefined) {
    loadingPayloads = true;
    localHtml = null;
    serverHtml = null;
    localEmpty = true;
    serverEmpty = true;
    try {
        const db = await getDB();
        const conflictItem = await db.get("items", conflictId);
        if (conflictItem) {
            const p = await decryptItemPayload<{ content?: unknown }>(conflictItem);
            localHtml = renderContent(p.content);
            localEmpty = extractPlainText(p.content).length === 0;
        }
        if (originalId) {
            const serverItem = await db.get("items", originalId);
            if (serverItem) {
                const p = await decryptItemPayload<{ content?: unknown }>(serverItem);
                serverHtml = renderContent(p.content);
                serverEmpty = extractPlainText(p.content).length === 0;
            }
        }
    } catch (e) {
        console.error("Failed to load payloads", e);
    } finally {
        loadingPayloads = false;
    }
}

async function resolveConflict(
    conflictId: string,
    originalId: string | undefined,
    action: "keep_local" | "keep_server" | "keep_both",
) {
    resolving = true;
    try {
        await resolveConflictInDB(conflictId, originalId, action);
        void pushPendingMutations();
    } catch (e) {
        console.error("Failed to resolve conflict", e);
    } finally {
        resolving = false;
    }
}
</script>

<Dialog title="Conflict Inbox" resizable onBackdropClick={onClose}>
    <div class="flex h-full border-t border-[var(--stroke)] bg-[var(--surface-app)]">
        <div class="w-64 border-r border-[var(--stroke)] overflow-y-auto flex flex-col">
            <Eyebrow class="px-3 py-2 bg-[color-mix(in_srgb,var(--surface-raised)_20%,transparent)]">
                Unresolved ({conflictStore.allConflicts.length})
            </Eyebrow>
            {#each conflictStore.allConflicts as conflict}
                <Button
                    variant="ghost"
                    active={selectedConflict?.id === conflict.id}
                    class="w-full !h-auto !justify-start rounded-none border-b border-[var(--stroke-soft)] border-l-2 {selectedConflict?.id === conflict.id ? 'border-l-amber-500 bg-[var(--surface-raised)]' : 'border-l-transparent'} px-3 py-2"
                    onclick={() => (selectedId = conflict.id)}
                >
                    <div class="w-full min-w-0 text-left">
                        <div class="flex items-center gap-2 mb-1">
                            {#if conflict.type === 'note' || conflict.type === 'folder'}
                                <FileText class="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            {:else}
                                <Image class="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            {/if}
                            <ItemTitle class="!text-[var(--text-sub)]">{conflict.title}</ItemTitle>
                        </div>
                        <MetaText as="div" class="truncate">
                            {formatDate(conflict.at)}
                        </MetaText>
                    </div>
                </Button>
            {/each}
        </div>

        <div class="flex-1 flex flex-col bg-[color-mix(in_srgb,var(--surface-panel)_30%,transparent)]">
            {#if selectedConflict}
                <div class="p-4 border-b border-[var(--stroke)] bg-[var(--surface-raised)]">
                    <h3 class="text-sm font-medium text-[var(--text-sub)]">{selectedConflict.title}</h3>
                    <MetaText as="p" class="mt-0.5">
                        This item was edited on another device while you were offline. Compare both versions, then choose how to resolve.
                    </MetaText>
                </div>

                <div class="flex-1 flex overflow-hidden">
                    {#if loadingPayloads}
                        <div class="flex-1 flex items-center justify-center text-[var(--text-dim)]">
                            Loading contents...
                        </div>
                    {:else}
                        <div class="flex-1 flex flex-col border-r border-[var(--stroke)] min-w-0">
                            <div class="p-2 bg-emerald-500/10 text-emerald-400 text-xs font-medium uppercase tracking-wider text-center border-b border-[var(--stroke)]">
                                Server Version
                            </div>
                            {#if serverEmpty}
                                <div class="flex-1 p-4 overflow-y-auto text-sm text-[var(--text-dim)] italic">
                                    (No readable text)
                                </div>
                            {:else}
                                <!-- eslint-disable-next-line svelte/no-at-html-tags — sanitised through sanitizeHtml -->
                                <div class="flex-1 p-4 overflow-y-auto prose prose-sm prose-invert max-w-none text-[var(--text-sub)] prose-headings:text-[var(--text)] prose-a:text-brand-fg prose-code:text-brand-fg prose-code:bg-[var(--surface-raised)] prose-code:px-1 prose-code:rounded prose-pre:bg-[var(--surface-raised)] prose-blockquote:border-brand0/50 prose-blockquote:text-[var(--text-muted)]">
                                    {@html serverHtml}
                                </div>
                            {/if}
                        </div>
                        <div class="flex-1 flex flex-col min-w-0">
                            <div class="p-2 bg-amber-500/10 text-amber-400 text-xs font-medium uppercase tracking-wider text-center border-b border-[var(--stroke)]">
                                Offline Version
                            </div>
                            {#if localEmpty}
                                <div class="flex-1 p-4 overflow-y-auto text-sm text-[var(--text-dim)] italic">
                                    (No readable text)
                                </div>
                            {:else}
                                <!-- eslint-disable-next-line svelte/no-at-html-tags — sanitised through sanitizeHtml -->
                                <div class="flex-1 p-4 overflow-y-auto prose prose-sm prose-invert max-w-none text-[var(--text-sub)] prose-headings:text-[var(--text)] prose-a:text-brand-fg prose-code:text-brand-fg prose-code:bg-[var(--surface-raised)] prose-code:px-1 prose-code:rounded prose-pre:bg-[var(--surface-raised)] prose-blockquote:border-brand0/50 prose-blockquote:text-[var(--text-muted)]">
                                    {@html localHtml}
                                </div>
                            {/if}
                        </div>
                    {/if}
                </div>

                <div class="px-4 py-3 border-t border-[var(--stroke)] bg-[color-mix(in_srgb,var(--surface-panel)_40%,transparent)]">
                    <MetaText as="p" class="leading-relaxed">
                        <span class="font-medium text-emerald-400">Keep Server Version</span> — discard offline edits and keep the server copy on the original.
                        <span class="text-[var(--text-muted)] mx-1">·</span>
                        <span class="font-medium text-amber-300">Keep Offline Version</span> — replace the server copy with your offline edits (same note).
                        <span class="text-[var(--text-muted)] mx-1">·</span>
                        <span class="font-medium text-[var(--text-sub)]">Keep Both</span> — keep the server version on the original and save offline edits as a separate note in the same folder.
                    </MetaText>
                </div>
                <DialogActions class="p-4 border-t border-[var(--stroke)] bg-[var(--surface-raised)]">
                    <Button
                        variant="ghost"
                        size="lg"
                        loading={resolving}
                        title="Keep the server version on the original and save offline edits as a separate note"
                        onclick={() =>
                            resolveConflict(selectedConflict!.id, selectedConflict!.conflict_of, "keep_both")}
                    >
                        <ArrowLeftRight class="w-4 h-4" />
                        Keep Both
                    </Button>
                    <Button
                        variant="success"
                        size="lg"
                        loading={resolving}
                        onclick={() =>
                            resolveConflict(selectedConflict!.id, selectedConflict!.conflict_of, "keep_server")}
                    >
                        <Check class="w-4 h-4" />
                        Keep Server Version
                    </Button>
                    <Button
                        variant="warning"
                        size="lg"
                        loading={resolving}
                        onclick={() =>
                            resolveConflict(selectedConflict!.id, selectedConflict!.conflict_of, "keep_local")}
                    >
                        <Check class="w-4 h-4" />
                        Keep Offline Version
                    </Button>
                </DialogActions>
            {:else}
                <EmptyState class="flex-1 flex items-center justify-center">
                    No conflict selected
                </EmptyState>
            {/if}
        </div>
    </div>
    
    {#snippet footer()}
        <DialogActions>
            <Button variant="normal" onclick={onClose}>Close</Button>
        </DialogActions>
    {/snippet}
</Dialog>
