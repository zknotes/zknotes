<script lang="ts">
import { createQuery, useQueryClient } from "@tanstack/svelte-query";
import {
    ChevronDown,
    ChevronRight,
    CornerDownRight,
    File as FileIcon,
    FileText,
    Folder,
    Home,
    RefreshCw,
    Trash2,
    Undo2,
    X,
} from "lucide-svelte";
import { goto } from "$app/navigation";
import { onMount } from "svelte";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import {
    batchAttachmentsForNote,
    type DeletedItemMeta,
    folderPathSegments,
    isIndividualTrashFile,
    isVisibleTrashRow,
    type PathSegment,
} from "$lib/core/data/items";
import Button from "$lib/core/ui/Button.svelte";
import Dialog from "$lib/core/ui/Dialog.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";
import {
    CollectionEmptyState,
    PageHeader,
    SegmentedControl,
    ToolbarSearch,
    UtilityCloseButton,
} from "$lib/core/ui";
import CollectionList from "$lib/core/ui/CollectionList.svelte";
import CollectionListRow from "$lib/core/ui/CollectionListRow.svelte";
import CollectionListSkeleton from "$lib/core/ui/CollectionListSkeleton.svelte";
import { formatDateOnly, humanSizeShort, trashRetentionLabel } from "$lib/core/utils/format";
import { effectiveTrashedBytes, localTrashedFileBytes } from "$lib/core/utils/storage-display";
import FileThumb from "$lib/modules/files/FileThumb.svelte";
import { FileService } from "$lib/modules/files/file-service";
import { ItemService } from "$lib/core/services/item-service";
import { activeSidebarId } from "$lib/core/stores/active-sidebar-id.svelte";
import { pendingExpandId } from "$lib/core/stores/pending-expand.svelte";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { expandedFolders } from "$lib/core/utils/expanded-folders";
const queryClient = useQueryClient();

const deletedQuery = createQuery(() => ({
    queryKey: QUERY_KEYS.deletedItems,
    queryFn: async () => {
        const { getDeletedItems } = await import("$lib/core/data/items");
        return getDeletedItems();
    },
}));

const treeQuery = createQuery(() => ({
    queryKey: QUERY_KEYS.treeItems,
    queryFn: async () => {
        const { getTreeItems } = await import("$lib/core/data/items");
        return getTreeItems();
    },
}));

type LocNode = { title: string; parent_id: string | null; deleted: boolean };
type TypeFilter = "all" | "items" | "files";

let searchQuery = $state("");
let typeFilter = $state<TypeFilter>("all");
let selectedIds = $state(new Set<string>());
let expandedNotes = $state(new Set<string>());
let confirmDialog = $state<
    | { kind: "one"; item: DeletedItemMeta }
    | { kind: "bulk"; ids: string[] }
    | { kind: "empty" }
    | null
>(null);
let deleting = $state(false);

let storage = $state<
    | {
          breakdown: {
              files_bytes: number;
              items_bytes: number;
              history_bytes: number;
              trashed_bytes: number;
              total_used: number;
          };
          storage_quota: number;
      }
    | "loading"
    | "error"
>("loading");
let trashSize = $state(0);

async function refreshTrashSize() {
    trashSize = await localTrashedFileBytes();
}

async function refreshStorage() {
    try {
        const { getStorage } = await import("$lib/core/api/files");
        storage = await getStorage();
    } catch {
        storage = "error";
    }
}

onMount(() => {
    void refreshStorage();
    void refreshTrashSize();
});

$effect(() => {
    deletedQuery.data;
    void refreshTrashSize();
});

let byId = $derived.by(() => {
    const map = new Map<string, LocNode>();
    for (const it of treeQuery.data ?? []) {
        map.set(it.id, { title: it.title, parent_id: it.parent_id, deleted: false });
    }
    for (const it of deletedQuery.data ?? []) {
        map.set(it.id, { title: it.title, parent_id: it.parent_id, deleted: true });
    }
    return map;
});

let allDeleted = $derived(deletedQuery.data ?? []);

let cachedNowSec = $derived(Math.floor(Date.now() / 1000));

let visibleItems = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    // The same rule as the sidebar badge (isVisibleTrashRow) — then the type filter + the search.
    let rows = allDeleted.filter((i) => {
        if (typeFilter === "all") return isVisibleTrashRow(i);
        if (typeFilter === "items") return i.type === "note" || i.type === "folder";
        return isIndividualTrashFile(i);
    });

    if (q) rows = rows.filter((i) => i.title.toLowerCase().includes(q));
    return rows.sort((a, b) => b.deleted_at - a.deleted_at);
});

type Location = {
    segments: PathSegment[];
    chain: string[];
    unreachable: boolean;
};

function locationOf(item: { parent_id: string | null }): Location {
    const segments = folderPathSegments(item.parent_id, byId);
    return {
        segments,
        chain: segments.map((s) => s.id),
        unreachable: segments.some((s) => s.deleted),
    };
}

function locationLabel(loc: Location): string {
    if (loc.segments.length === 0) return "Home";
    return loc.segments.map((s) => s.title).join(" / ");
}

function relativeDate(ts: number): string {
    return formatDateOnly(ts);
}

function iconFor(item: DeletedItemMeta) {
    if (item.type === "folder") return Folder;
    if (item.type === "file") return FileIcon;
    return FileText;
}

function toggleExpanded(noteId: string) {
    const next = new Set(expandedNotes);
    if (next.has(noteId)) next.delete(noteId);
    else next.add(noteId);
    expandedNotes = next;
}

function toggleSelected(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
}

function selectAll() {
    selectedIds = new Set(visibleItems.map((i) => i.id));
}

function clearSelection() {
    selectedIds = new Set();
}

function reveal(item: DeletedItemMeta, loc: Location) {
    // The whole ancestor path (localStorage + UI), not only the parent — a collapsed ancestor would otherwise hide the restore.
    for (const id of loc.chain) expandedFolders.expand(id);
    if (loc.chain.length > 0) pendingExpandId.request(loc.chain);
    activeSidebarId.set(item.id);
    if (item.type === "note") goto(`/note/${item.id}`);
    else if (item.type === "file") goto(`/files?file=${item.id}`);
    else goto("/");
}

async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.deletedItems });
    await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    // The local trash size straight away (IDB); the /me/storage API may still carry the old quota until the purge lands.
    await refreshTrashSize();
    void refreshStorage();
}

async function restoreItem(item: DeletedItemMeta) {
    const loc = locationOf(item);
    const label = locationLabel(loc);

    let restoreMsg = `Restored "${item.title}"${item.type === "file" ? "" : ` to ${label}`}`;
    let viewAction: { label: string; onClick: () => void } | undefined =
        item.type === "note" ? { label: "View", onClick: () => reveal(item, loc) } : undefined;

    if (item.type === "file") {
        const result = await FileService.restore(item.id);
        if (result) {
            restoreMsg = `Restored to end of "${result.noteTitle}".`;
            viewAction = {
                label: "View",
                onClick: () => goto(`/note/${result.appendedToNoteId}`),
            };
        }
    } else {
        await ItemService.restoreItem(item.id);
    }
    await invalidate();
    selectedIds = new Set([...selectedIds].filter((id) => id !== item.id));

    globalToasts.add({
        variant: "success",
        message: restoreMsg,
        action: viewAction,
    });
}

async function restoreBatchFile(file: DeletedItemMeta, note: DeletedItemMeta) {
    await ItemService.restoreItem(file.id);
    await invalidate();
    globalToasts.add({
        variant: "success",
        message: `Restored file + parent note "${note.title}".`,
        action: { label: "View", onClick: () => goto(`/note/${note.id}`) },
    });
}

function requestPermanentDelete(item: DeletedItemMeta) {
    confirmDialog = { kind: "one", item };
}

function requestBulkDeleteForever() {
    if (selectedIds.size === 0) return;
    confirmDialog = { kind: "bulk", ids: [...selectedIds] };
}

function requestEmptyTrash() {
    if (allDeleted.length === 0) return;
    confirmDialog = { kind: "empty" };
}

async function performPermanentDelete(id: string) {
    const item = allDeleted.find((i) => i.id === id);
    if (item?.type === "file") {
        await FileService.hardDelete([id]);
    } else {
        await ItemService.permanentDeleteItem(id);
    }
    await invalidate();
    selectedIds = new Set([...selectedIds].filter((x) => x !== id));
    globalToasts.add({ variant: "info", message: "Deleted forever." });
}

async function bulkRestore() {
    const ids = [...selectedIds];
    for (const id of ids) {
        const item = allDeleted.find((i) => i.id === id);
        if (!item) continue;
        if (item.type === "file") await FileService.restore(id);
        else await ItemService.restoreItem(id);
    }
    await invalidate();
    selectedIds = new Set();
}

async function performBulkDeleteForever(ids: string[]) {
    const fileIds = ids.filter((id) => allDeleted.find((i) => i.id === id)?.type === "file");
    const otherIds = ids.filter((id) => !fileIds.includes(id));
    if (fileIds.length) await FileService.hardDelete(fileIds);
    if (otherIds.length) await ItemService.permanentDeleteItem(otherIds);
    await invalidate();
    selectedIds = new Set();
    globalToasts.add({
        variant: "info",
        message: `${ids.length} items deleted forever.`,
    });
}

async function performEmptyTrash() {
    await ItemService.permanentDeleteItem(allDeleted.map((i) => i.id));
    await invalidate();
    selectedIds = new Set();
    expandedNotes = new Set();
    globalToasts.add({ variant: "info", message: "Trash emptied." });
}

async function confirmDestructiveAction() {
    if (!confirmDialog || deleting) return;
    deleting = true;
    const action = confirmDialog;
    confirmDialog = null;
    try {
        if (action.kind === "one") await performPermanentDelete(action.item.id);
        else if (action.kind === "bulk") await performBulkDeleteForever(action.ids);
        else await performEmptyTrash();
    } finally {
        deleting = false;
    }
}
</script>

<div class="relative flex-1 overflow-y-auto bg-[var(--surface-app)] fade-in" data-testid="trash-list">
    <div class="absolute top-3 right-3 z-20">
        <UtilityCloseButton />
    </div>
    <div class="max-w-6xl mx-auto px-3 sm:px-8 py-10">
        <PageHeader title="Trash" eyebrowClass="!text-rose-400/80">
            {#snippet eyebrow()}
                <Trash2 class="w-[0.6875rem] h-[0.6875rem]" />
                Trash · {visibleItems.length} items
            {/snippet}
            {#snippet description()}
                Deleted notes, folders, and files. Restore or delete forever.
            {/snippet}
            {#snippet actions()}
                {#if allDeleted.length > 0}
                    <Button variant="danger-ghost" onclick={requestEmptyTrash}>
                        <Trash2 class="w-3 h-3" /> Empty trash
                    </Button>
                {/if}
            {/snippet}
        </PageHeader>

        <div class="flex flex-wrap items-center gap-2 mb-4">
            <ToolbarSearch bind:value={searchQuery} />
            <SegmentedControl
                options={[
                    { id: "all", label: "All" },
                    { id: "items", label: "Notes & Folders" },
                    { id: "files", label: "Files" },
                ]}
                value={typeFilter}
                onChange={(id) => (typeFilter = id as TypeFilter)}
            />
            {#if visibleItems.length > 0 && selectedIds.size !== visibleItems.length}
                <Button variant="normal" size="sm" onclick={selectAll}>Select all</Button>
            {/if}
            {#if selectedIds.size > 0}
                <span class="text-xs font-mono text-[var(--text-muted)]">{selectedIds.size} selected</span>
                <Button variant="normal" size="sm" onclick={clearSelection}>Clear</Button>
                <Button size="sm" onclick={bulkRestore}>
                    <Undo2 class="w-3 h-3" /> Restore
                </Button>
                <Button variant="danger-ghost" size="sm" onclick={requestBulkDeleteForever}>
                    <X class="w-3 h-3" /> Delete forever
                </Button>
            {/if}
        </div>

        {#if storage === "loading"}
            <div class="h-1.5 w-full bg-[var(--surface-raised)] rounded-full overflow-hidden animate-pulse mb-4"></div>
        {:else if storage === "error"}
            <div class="flex items-center gap-2 mb-4">
                <div class="text-xs font-mono text-[var(--text-dim)]">Storage unavailable</div>
                <Button variant="ghost" size="sm" aria-label="Refresh storage" onclick={refreshStorage} class="!p-1 !h-auto !min-w-0">
                    <RefreshCw class="w-3 h-3 text-[var(--text-dim)]" />
                </Button>
            </div>
        {:else}
            {@const effTrashed = effectiveTrashedBytes(storage.breakdown.trashed_bytes, trashSize)}
            {@const trashPct = storage.storage_quota > 0 ? Math.min(100, (effTrashed / storage.storage_quota) * 100) : 0}
            <div class="mb-4">
                <div class="h-1.5 w-full bg-[var(--surface-raised)] rounded-full overflow-hidden">
                    <div
                        class="h-full bg-[var(--text-muted)] transition-all"
                        style="width: {trashPct}%"
                        title="Trash: {humanSizeShort(effTrashed)}"
                    ></div>
                </div>
                <div class="flex items-center gap-2 mt-1">
                    <span class="text-xs font-mono text-[var(--text-dim)]">
                        {humanSizeShort(effTrashed)} in trash
                    </span>
                    <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Refresh storage"
                        onclick={() => {
                            void refreshStorage();
                            void refreshTrashSize();
                        }}
                        class="!p-1 !h-auto !min-w-0"
                        title="Refresh trash usage"
                    >
                        <RefreshCw class="w-3 h-3 text-[var(--text-dim)]" />
                    </Button>
                </div>
            </div>
        {/if}

        {#if deletedQuery.isLoading}
            <CollectionListSkeleton count={4} />
        {:else if visibleItems.length === 0}
            <CollectionEmptyState
                icon={Trash2}
                title="Trash is empty"
                subtitle="Deleted items will appear here."
            />
        {:else}
            <CollectionList>
                {#each visibleItems as item (item.id)}
                    {@const Icon = iconFor(item)}
                    {@const loc = locationOf(item)}
                    {@const batchFiles =
                        item.type === "note"
                            ? batchAttachmentsForNote(allDeleted, item.id, item.trashed_batch_id)
                            : []}
                    <CollectionListRow
                        title={item.title}
                        muted
                        selectable
                        checked={selectedIds.has(item.id)}
                        ontoggle={() => toggleSelected(item.id)}
                        onclick={() => toggleSelected(item.id)}
                    >
                        {#snippet thumb()}
                            {#if item.type === "file"}
                                <FileThumb
                                    fileId={item.id}
                                    mime={item.mime}
                                    icon={FileIcon}
                                    updatedAt={item.updated_at}
                                />
                            {:else}
                                <div
                                    class="w-full h-full bg-[var(--surface-raised)] flex items-center justify-center text-[var(--text-muted)]"
                                >
                                    {#if item.icon}
                                        <span class="text-sm">{item.icon}</span>
                                    {:else}
                                        <Icon class="w-[0.8125rem] h-[0.8125rem]" />
                                    {/if}
                                </div>
                            {/if}
                        {/snippet}
                        {#snippet subtitle()}
                            {@const retention = trashRetentionLabel(item.deleted_at, cachedNowSec)}
                            <div class="flex items-center gap-2 text-2xs font-mono text-[var(--text-dim)] mt-0.5 flex-wrap">
                                {#if item.type === "file"}
                                    <span>{humanSizeShort(item.size ?? 0)}</span>
                                    <span>·</span>
                                {/if}
                                <span
                                    class="flex items-center gap-1 min-w-0 max-w-[60%] truncate"
                                    title={`Was in ${locationLabel(loc)}`}
                                >
                                    {#if loc.segments.length === 0}
                                        <Home class="w-[0.625rem] h-[0.625rem] flex-shrink-0" />
                                    {:else}
                                        <CornerDownRight class="w-[0.625rem] h-[0.625rem] flex-shrink-0" />
                                    {/if}
                                    <span class="truncate {loc.unreachable ? 'text-amber-500' : ''}">
                                        {locationLabel(loc)}{loc.unreachable ? " (in Trash)" : ""}
                                    </span>
                                </span>
                                <span>·</span>
                                <span>Deleted {relativeDate(item.deleted_at)}</span>
                                {#if retention}
                                    <span>·</span>
                                    <span class="text-amber-500/90 font-medium">{retention.daysLeftText}</span>
                                {/if}
                                {#if batchFiles.length > 0}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        class="!text-2xs !h-auto !px-1.5 !py-0"
                                        onclick={() => toggleExpanded(item.id)}
                                    >
                                        {#if expandedNotes.has(item.id)}
                                            <ChevronDown class="w-3 h-3" />
                                        {:else}
                                            <ChevronRight class="w-3 h-3" />
                                        {/if}
                                        {batchFiles.length} attachments
                                    </Button>
                                {/if}
                            </div>
                        {/snippet}
                        {#snippet actions()}
                            <Button size="sm" onclick={() => restoreItem(item)}>
                                <Undo2 class="w-[0.6875rem] h-[0.6875rem]" /> Restore
                            </Button>
                            <Button variant="danger-ghost" size="sm" onclick={() => requestPermanentDelete(item)}>
                                <X class="w-[0.6875rem] h-[0.6875rem]" /> Delete forever
                            </Button>
                        {/snippet}
                    </CollectionListRow>
                    {#if item.type === "note" && expandedNotes.has(item.id) && batchFiles.length > 0}
                        {#each batchFiles as bf (bf.id)}
                            <div class="flex items-center gap-3 py-2 px-3 pl-12 border-b border-[var(--stroke)]/40 bg-[var(--surface-panel)]/30 w-full">
                                <div class="w-8 h-8 rounded overflow-hidden flex-shrink-0 bg-[var(--surface-raised)]">
                                    <FileThumb fileId={bf.id} mime={bf.mime} icon={FileIcon} updatedAt={bf.updated_at} />
                                </div>
                                <div class="flex-1 min-w-[10rem] overflow-hidden">
                                    <div class="text-xs truncate">{bf.title}</div>
                                    <div class="text-2xs font-mono text-[var(--text-dim)]">
                                        {humanSizeShort(bf.size ?? 0)}
                                    </div>
                                </div>
                                <div class="flex items-center gap-2 flex-shrink-0">
                                    <Button size="sm" onclick={() => restoreBatchFile(bf, item)}>Restore</Button>
                                    <Button variant="danger-ghost" size="sm" onclick={() => requestPermanentDelete(bf)}>
                                        Delete forever
                                    </Button>
                                </div>
                            </div>
                        {/each}
                    {/if}
                {/each}
            </CollectionList>
        {/if}
    </div>
</div>

{#if confirmDialog}
    {@const d = confirmDialog}
    <Dialog title={d.kind === "empty" ? "Empty trash?" : "Delete forever?"}>
        {#snippet children()}
            <p class="text-xs text-[var(--text-muted)] mb-3">
                {#if d.kind === "one"}
                    This permanently deletes "{d.item.title}" and cannot be undone.
                {:else if d.kind === "bulk"}
                    This permanently deletes {d.ids.length} items and cannot be undone.
                {:else}
                    This permanently deletes all {allDeleted.length} items in trash and cannot be undone.
                {/if}
            </p>
        {/snippet}
        {#snippet footer()}
            <DialogActions>
                <Button onclick={() => (confirmDialog = null)}>Cancel</Button>
                <Button variant="danger" disabled={deleting} onclick={confirmDestructiveAction}>
                    {d.kind === "empty" ? "Empty trash" : "Delete forever"}
                </Button>
            </DialogActions>
        {/snippet}
    </Dialog>
{/if}