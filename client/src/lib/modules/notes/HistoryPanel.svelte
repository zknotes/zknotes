<script lang="ts">
import type { HistorySnapshot, NotePayload } from "@zknotes/shared";
import { useQueryClient } from "@tanstack/svelte-query";
import type { Editor } from "@tiptap/core";
import { Clock, Info, RotateCcw, Trash2, X } from "lucide-svelte";
import { clearAllSnapshots, deleteSnapshot, listSnapshots } from "$lib/core/api";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import { ItemService } from "$lib/core/services/item-service";
import { decryptSnapshot, maybeCreateSnapshot } from "$lib/core/sync/history";
import { Button, MetaText, ItemTitle, EmptyState, ErrorText } from "$lib/core/ui";
import { formatShortDate, formatTime } from "$lib/core/utils/format";
import type { NoteAutosave } from "./NoteAutosave.svelte";
import HistoryPreview from "./HistoryPreview.svelte";

let {
    noteId,
    editor,
    autosave,
    visible,
    onRestored,
}: {
    noteId: string;
    editor: Editor | undefined;
    autosave?: NoteAutosave;
    visible: boolean;
    onRestored?: () => void;
} = $props();

const queryClient = useQueryClient();

const noteTitle = $derived(
    (queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems) ?? []).find(
        (i) => i.id === noteId,
    )?.title ?? "Untitled",
);

let snapshots = $state<HistorySnapshot[]>([]);
let loading = $state(false);
let error = $state<string | null>(null);

let selectedId = $state<string | null>(null);
let previewPayload = $state<NotePayload | null>(null);
let previewLoading = $state(false);
let previewError = $state<string | null>(null);

// The attachment note is shown only when a snapshot really carries an attachment — otherwise it is
// pure noise.
// `data-file-id` is a stable marker of an encFile node (see enc-file-node.ts's parseHTML).
let previewHasAttachments = $derived((previewPayload?.content ?? "").includes("data-file-id"));

let restoring = $state(false);
let deleting = $state<string | null>(null);
let savingManual = $state(false);
let manualSaved = $state(false);
let clearingAll = $state(false);
let confirmClear = $state(false);

$effect(() => {
    if (visible) void loadSnapshots();
});

// Close the preview when the sidebar is hidden
$effect(() => {
    if (!visible) {
        selectedId = null;
        previewPayload = null;
    }
});

async function loadSnapshots() {
    loading = true;
    error = null;
    try {
        const result = await listSnapshots(noteId, { limit: 50 });
        snapshots = result.snapshots;
    } catch (e) {
        error = "Could not load history.";
    } finally {
        loading = false;
    }
}

async function selectSnapshot(snap: HistorySnapshot) {
    if (selectedId === snap.id) {
        selectedId = null;
        previewPayload = null;
        return;
    }
    selectedId = snap.id;
    previewPayload = null;
    previewLoading = true;
    previewError = null;
    try {
        previewPayload = await decryptSnapshot<NotePayload>(noteId, snap);
    } catch {
        previewError = "Could not decrypt snapshot.";
    } finally {
        previewLoading = false;
    }
}

function closePreview() {
    selectedId = null;
    previewPayload = null;
    previewError = null;
}

async function restore() {
    if (!previewPayload || !selectedId) return;
    restoring = true;
    try {
        if (autosave?.isDirty) {
            autosave.flush(noteId);
        }
        await maybeCreateSnapshot(noteId).catch(() => {});
        await ItemService.updateItemPayload(
            noteId,
            previewPayload.contentTitle ?? previewPayload.title,
            previewPayload.content,
        );
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.note(noteId) });
        if (editor && !editor.isDestroyed) {
            editor.commands.setContent(previewPayload.content);
        }
        closePreview();
        onRestored?.();
    } catch {
        previewError = "Restore failed.";
    } finally {
        restoring = false;
    }
}

// A direct restore without opening the preview — it decrypts and restores at once.
let restoringDirectId = $state<string | null>(null);
async function restoreDirect(snap: HistorySnapshot) {
    restoringDirectId = snap.id;
    try {
        if (autosave?.isDirty) {
            autosave.flush(noteId);
        }
        const payload = await decryptSnapshot<NotePayload>(noteId, snap);
        await maybeCreateSnapshot(noteId).catch(() => {});
        await ItemService.updateItemPayload(
            noteId,
            payload.contentTitle ?? payload.title,
            payload.content,
        );
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.note(noteId) });
        if (editor && !editor.isDestroyed) {
            editor.commands.setContent(payload.content);
        }
        closePreview();
        onRestored?.();
    } catch {
        previewError = "Restore failed.";
    } finally {
        restoringDirectId = null;
    }
}

async function removeSnapshot(snap: HistorySnapshot) {
    deleting = snap.id;
    try {
        await deleteSnapshot(noteId, snap.id);
        snapshots = snapshots.filter((s) => s.id !== snap.id);
        if (selectedId === snap.id) closePreview();
    } catch {
        // not fatal
    } finally {
        deleting = null;
    }
}

async function clearAll() {
    confirmClear = false;
    clearingAll = true;
    try {
        await clearAllSnapshots(noteId);
        snapshots = [];
        closePreview();
    } catch {
        // not fatal
    } finally {
        clearingAll = false;
    }
}

let manualSavedTimer: ReturnType<typeof setTimeout> | undefined;
$effect(() => () => clearTimeout(manualSavedTimer));

async function saveManualSnapshot() {
    savingManual = true;
    manualSaved = false;
    try {
        await maybeCreateSnapshot(noteId);
        await loadSnapshots();
        manualSaved = true;
        clearTimeout(manualSavedTimer);
        manualSavedTimer = setTimeout(() => (manualSaved = false), 2000);
    } catch {
        // not fatal
    } finally {
        savingManual = false;
    }
}

function formatHistoryDate(ms: number): string {
    const d = new Date(ms);
    const now = new Date();
    const diffSec = Math.floor((Date.now() - ms) / 1000);
    if (diffSec < 60) return "Just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    const time = formatTime(Math.floor(ms / 1000));
    if (sameDay) return `Today ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
        d.getFullYear() === yesterday.getFullYear() &&
        d.getMonth() === yesterday.getMonth() &&
        d.getDate() === yesterday.getDate();
    if (isYesterday) return `Yesterday ${time}`;
    return `${formatShortDate(Math.floor(ms / 1000))} ${time}`;
}
</script>

<!-- The sidebar panel: full width, a single-column list -->
<div class="flex flex-col h-full bg-[var(--surface-panel)]">
    <!-- Header -->
    <div class="flex-shrink-0 border-b border-[var(--stroke)]">
        <div class="h-11 flex items-center justify-between px-4">
            <div class="flex items-center gap-2 text-xs font-medium text-[var(--text-sub)]">
                <Clock class="w-3.5 h-3.5 text-[var(--text-muted)]" />
                Version History
            </div>
            <div class="flex items-center gap-1.5">
                {#if confirmClear}
                    <span class="text-xs text-[var(--text-muted)]">Delete all?</span>
                    <Button variant="danger" size="sm" onclick={clearAll} disabled={clearingAll}>Yes, clear</Button>
                    <Button size="sm" onclick={() => (confirmClear = false)}>Cancel</Button>
                {:else}
                    {#if snapshots.length > 0}
                        <Button
                            variant="danger-ghost"
                            size="sm"
                            onclick={() => (confirmClear = true)}
                            disabled={clearingAll}
                            title="Delete all history"
                        >Clear all</Button>
                    {/if}
                    <Button
                        variant={manualSaved ? "primary" : "normal"}
                        size="sm"
                        onclick={saveManualSnapshot}
                        disabled={savingManual}
                        title="Save current state to history"
                    >
                        {#if savingManual}Saving…{:else if manualSaved}Saved!{:else}Save now{/if}
                    </Button>
                {/if}
            </div>
        </div>
    </div>

    <!-- The snapshot list — the panel's full width -->
    <div class="flex-1 overflow-y-auto">
        {#if loading}
            <div class="flex items-center justify-center h-20 text-[var(--text-dim)] text-xs">
                Loading…
            </div>
        {:else if error}
            <ErrorText class="px-4 py-4">{error}</ErrorText>
        {:else if snapshots.length === 0}
            <EmptyState class="px-4 py-6 text-center">
                <Clock class="w-8 h-8 text-[var(--text-dim)] mx-auto mb-2" />
                <p>No history yet.</p>
                <p class="mt-1">Versions are saved when you navigate away from a note.</p>
            </EmptyState>
        {:else}
            <ul class="py-1">
                {#each snapshots as snap (snap.id)}
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <li
                        role="option"
                        aria-selected={selectedId === snap.id}
                        onclick={() => selectSnapshot(snap)}
                        onkeydown={(e) => e.key === "Enter" && selectSnapshot(snap)}
                        class="px-3 py-2.5 flex items-center gap-2 hover:bg-[color-mix(in_srgb,var(--surface-raised)_60%,transparent)] transition-colors group cursor-pointer
                               {selectedId === snap.id ? 'bg-[color-mix(in_srgb,var(--surface-raised)_80%,transparent)] border-l-2 border-brand0' : 'border-l-2 border-transparent'}"
                    >
                        <div class="flex-1 min-w-0">
                            <ItemTitle as="p" size="xs" class="text-[var(--text)]">
                                {formatHistoryDate(snap.created_at * 1000)}
                            </ItemTitle>
                            <MetaText as="p" class="!text-2xs">#{snap.snapshot_number ?? snap.item_version_at_snapshot}</MetaText>
                        </div>
                        <div class="flex items-center gap-0.5 hover-reveal transition-opacity flex-shrink-0">
                            <Button
                                variant="ghost"
                                size="icon"
                                onclick={(e) => { e.stopPropagation(); void restoreDirect(snap); }}
                                disabled={restoringDirectId === snap.id}
                                class="hover:text-brand-fg hover:bg-brand0/10"
                                title="Restore this version"
                            >
                                {#if restoringDirectId === snap.id}
                                    <svg class="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-opacity=".25"/><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                                {:else}
                                    <RotateCcw class="w-3 h-3" />
                                {/if}
                            </Button>
                            <Button
                                variant="danger-ghost"
                                size="icon"
                                onclick={(e) => { e.stopPropagation(); removeSnapshot(snap); }}
                                disabled={deleting === snap.id}
                                title="Delete this version"
                            >
                                <Trash2 class="w-3 h-3" />
                            </Button>
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</div>

<!-- The preview overlay — from the left app sidebar to the history panel (the editor zone's full width) -->
{#if selectedId}
    <div
        class="fixed inset-y-0 z-[45] flex overflow-hidden pointer-events-none history-preview-overlay"
        style="left: var(--app-sidebar-w, 280px); right: var(--history-panel-w, 17rem);"
    >
        <!-- The preview panel — full width up to the left sidebar; the version list stays on the right -->
        <div class="relative w-full h-full bg-[var(--surface-panel)] border-r border-[var(--stroke)] flex flex-col shadow-2xl pointer-events-auto">
            <!-- Restore bar -->
            <div class="h-10 flex items-center justify-between px-4 border-b border-[var(--stroke)] flex-shrink-0">
                <MetaText as="p" class="truncate">
                    Preview — <span class="text-[var(--text-sub)]">{noteTitle}</span>
                </MetaText>
                <div class="flex items-center gap-2 flex-shrink-0">
                    <Button
                        variant="ghost"
                        size="icon"
                        onclick={closePreview}
                        title="Close preview"
                    >
                        <X class="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="primary" size="sm" disabled={restoring || !previewPayload} onclick={restore}>
                        <RotateCcw class="w-3 h-3" />
                        {restoring ? "Restoring…" : "Restore this version"}
                    </Button>
                </div>
            </div>

            <!-- The content -->
            <div class="flex-1 overflow-y-auto px-8 py-8">
                {#if previewLoading}
                    <div class="flex items-center justify-center h-20 text-[var(--text-dim)] text-xs">
                        Decrypting…
                    </div>
                {:else if previewError}
                    <ErrorText>{previewError}</ErrorText>
                {:else if previewPayload}
                    {#if previewHasAttachments}
                        <!-- History stores a note's payload, not an image's bytes.
                             An attachment is resolved against the file's CURRENT state (a crop is
                             in-place), so an old version does not guarantee the old image. One static
                             note, with no
                             per-file classification. -->
                        <div
                            class="flex items-start gap-2 mb-6 px-3 py-2 rounded-md bg-[var(--surface-raised)] border border-[var(--stroke)]"
                        >
                            <Info
                                class="w-3.5 h-3.5 mt-px flex-shrink-0 text-[var(--text-dim)]"
                            />
                            <MetaText as="p" class="normal-case tracking-normal">
                                Attachments show their current content, not how they looked in this
                                version.
                            </MetaText>
                        </div>
                    {/if}
                    <HistoryPreview content={previewPayload.content} />
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    /* Desktop: the preview runs from the left sidebar to the version list (17rem in from the right).
       On mobile that formula leaves only a narrow, practically invisible strip (sidebar-w is 0 while
       the list still takes its 17rem) — so on mobile the preview covers the whole screen (and the list
       itself behind it, hence the higher z-index). */
    @media (max-width: 767px) {
        .history-preview-overlay {
            left: 0 !important;
            right: 0 !important;
        }
    }
</style>
