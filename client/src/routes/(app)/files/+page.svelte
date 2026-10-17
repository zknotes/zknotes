<script lang="ts">
import { createQuery, useQueryClient } from "@tanstack/svelte-query";
import { ChevronDown, FileImage, FolderClosed, Loader2, RefreshCw, Trash2, X } from "lucide-svelte";
import { onMount } from "svelte";
import { goto, replaceState } from "$app/navigation";
import { page } from "$app/state";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import {
    filterFilesByScope,
    matchesFileType,
    parseScopeParam,
    parseTypeParam,
    type FileTypeFilter,
    type ParsedScope,
    scopeLabel,
    scopeToParam,
    typeToParam,
} from "$lib/core/data/file-filters";
import { type DecryptedItemMeta, folderPathSegments } from "$lib/core/data/items";
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
import { humanSizeShort } from "$lib/core/utils/format";
import FileDetailPanel from "$lib/modules/files/FileDetailPanel.svelte";
import { FileService } from "$lib/modules/files/file-service";
import NotePickerModal from "$lib/modules/files/NotePickerModal.svelte";
import VirtualFiles, { type VirtualItem } from "$lib/modules/files/VirtualFiles.svelte";
import { effectiveTrashedBytes, localTrashedFileBytes } from "$lib/core/utils/storage-display";

const queryClient = useQueryClient();

let selectedId = $state<string | null>(null);
let selectedIds = $state(new Set<string>());
let deleting = $state(false);
let deleteDialog = $state<{ fileIds: string[] } | null>(null);

let searchQuery = $state("");
let sortBy = $state<
    "updated_desc" | "updated_asc" | "size_desc" | "size_asc" | "name_asc" | "type_asc"
>("updated_desc");

let scope = $state<ParsedScope>({ kind: "all" });
let typeFilter = $state<FileTypeFilter>("all");
let showNotePicker = $state(false);
let showFolderPicker = $state(false);
let scopeMenuOpen = $state(false);

function buildFilesUrl(params: URLSearchParams): string {
    const qs = params.toString();
    return `/files${qs ? `?${qs}` : ""}`;
}

function syncFiltersFromUrl() {
    const params = page.url.searchParams;
    scope = parseScopeParam(params.get("scope"));
    typeFilter = parseTypeParam(params.get("type"));
}

function pushFilterUrl(nextScope: ParsedScope, nextType: FileTypeFilter) {
    const params = new URLSearchParams(page.url.searchParams);
    const scopeParam = scopeToParam(nextScope);
    const typeParam = typeToParam(nextType);
    if (scopeParam) params.set("scope", scopeParam);
    else params.delete("scope");
    if (typeParam) params.set("type", typeParam);
    else params.delete("type");
    params.delete("file");
    replaceState(buildFilesUrl(params), {});
}

function setScope(next: ParsedScope) {
    scope = next;
    scopeMenuOpen = false;
    pushFilterUrl(next, typeFilter);
}

function setTypeFilter(next: FileTypeFilter) {
    typeFilter = next;
    pushFilterUrl(scope, next);
}

$effect(() => {
    page.url.searchParams;
    syncFiltersFromUrl();
});

function toggleSelected(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
}

function selectAll() {
    selectedIds = new Set(files.filter((f) => !("isGroupHeader" in f)).map((f) => f.id));
}

function clearSelection() {
    selectedIds = new Set();
}

async function deleteSelected() {
    if (selectedIds.size === 0 || deleting) return;
    deleteDialog = { fileIds: [...selectedIds] };
}

async function performDelete(fileIds: string[]) {
    deleting = true;
    deleteDialog = null;
    try {
        await Promise.all(fileIds.map((id) => FileService.trash(id)));
        const { globalToasts } = await import("$lib/core/stores/toast.svelte");
        globalToasts.add({
            variant: "info",
            message: `${fileIds.length} ${fileIds.length === 1 ? "file" : "files"} moved to trash`,
            durationMs: 5000,
        });
        await refreshStorage();
        selectedIds = new Set();
    } finally {
        deleting = false;
    }
}

const itemsQuery = createQuery(() => ({
    queryKey: QUERY_KEYS.treeItems,
    queryFn: async () => {
        const { getTreeItems } = await import("$lib/core/data/items");
        return getTreeItems();
    },
}));

const selected = $derived(
    selectedId !== null ? ((itemsQuery.data ?? []).find((i) => i.id === selectedId) ?? null) : null,
);

$effect(() => {
    const fid = page.url.searchParams.get("file");
    if (!fid) return;
    const target = (itemsQuery.data ?? []).find((i) => i.id === fid && i.type === "file");
    if (!target) return;
    selectedId = target.id;
    const params = new URLSearchParams(page.url.searchParams);
    params.delete("file");
    replaceState(buildFilesUrl(params), {});
});

// `?view=grid` — marketing shots / a deep link; the default stays list.
let mode = $state<"grid" | "list">(page.url.searchParams.get("view") === "grid" ? "grid" : "list");

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
          max_file_size: number;
      }
    | "loading"
    | "error"
>("loading");
let trashSize = $state(0);

async function refreshStorage() {
    try {
        const { getStorage } = await import("$lib/core/api/files");
        storage = await getStorage();
    } catch {
        storage = "error";
    }
}

async function refreshTrashSize() {
    trashSize = await localTrashedFileBytes();
}

onMount(() => {
    void refreshStorage();
    syncFiltersFromUrl();
});

$effect(() => {
    itemsQuery.data;
    void refreshTrashSize();
    void refreshStorage();
});

const folderOptions = $derived(
    (itemsQuery.data ?? [])
        .filter((i) => i.type === "folder")
        .sort((a, b) => a.title.localeCompare(b.title)),
);

let files = $derived.by<VirtualItem[]>(() => {
    const allItems = itemsQuery.data ?? [];
    const itemMap = new Map<string, DecryptedItemMeta>();
    for (const i of allItems) itemMap.set(i.id, i);

    let rawFiles = allItems.filter((i) => i.type === "file");
    rawFiles = filterFilesByScope(rawFiles, scope, allItems);
    rawFiles = rawFiles.filter((f) => matchesFileType(f.mime, typeFilter));

    rawFiles.sort((a, b) => {
        if (sortBy === "updated_desc") return b.updated_at - a.updated_at;
        if (sortBy === "updated_asc") return a.updated_at - b.updated_at;
        if (sortBy === "size_desc") return (b.size || 0) - (a.size || 0);
        if (sortBy === "size_asc") return (a.size || 0) - (b.size || 0);
        if (sortBy === "name_asc") return a.title.localeCompare(b.title);
        if (sortBy === "type_asc") {
            const typeA = a.mime || "";
            const typeB = b.mime || "";
            if (typeA !== typeB) return typeA.localeCompare(typeB);
            return a.title.localeCompare(b.title);
        }
        return b.updated_at - a.updated_at;
    });

    const q = searchQuery.trim().toLowerCase();
    if (q) {
        rawFiles = rawFiles.filter((f) => f.title.toLowerCase().includes(q));
    }

    return rawFiles.map((f) => ({
        ...f,
        fullPath: f.parent_id
            ? folderPathSegments(f.parent_id, itemMap)
                  .map((s) => s.title)
                  .join(" / ") || "Home"
            : "Unlinked",
    }));
});

let selectableFilesCount = $derived(files.filter((f) => !("isGroupHeader" in f)).length);

const LOADING_SKELETON_COUNT = 8;

const TYPE_CHIPS: { id: FileTypeFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "images", label: "Images" },
    { id: "docs", label: "Documents" },
    { id: "audio", label: "Audio" },
    { id: "video", label: "Video" },
];

const headerTitle = $derived(
    scope.kind === "all" ? "All Files" : scopeLabel(scope, itemsQuery.data ?? []),
);
</script>

<div class="relative flex-1 flex flex-col overflow-hidden bg-[var(--surface-app)] fade-in">
    <div class="absolute top-3 right-3 z-20">
        <UtilityCloseButton />
    </div>
    <div class="max-w-6xl w-full mx-auto px-3 sm:px-8 pt-10 pb-4 flex-shrink-0">
        <PageHeader title={headerTitle} eyebrowClass="!text-brand-fg/80">
            {#snippet eyebrow()}
                Files · {files.length}
            {/snippet}
            {#snippet description()}
                Encrypted files in your vault. Upload from within a note. Deleted files are in
                <Button
                    variant="ghost"
                    size="sm"
                    class="!inline !h-auto !px-1 !py-0 !text-brand0/80 hover:!text-brand-fg"
                    onclick={() => goto("/trash")}
                >Trash</Button>.
            {/snippet}
            {#snippet actions()}
                <ToolbarSearch bind:value={searchQuery} placeholder="Search files..." />
                {#if selectableFilesCount > 0 && selectedIds.size !== selectableFilesCount}
                    <Button variant="normal" size="sm" class="flex-shrink-0" onclick={selectAll}>
                        Select all
                    </Button>
                {/if}
            {/snippet}
        </PageHeader>

        <!-- The scope + type filters -->
        <div class="flex flex-wrap items-center gap-2 mb-3">
            <div class="relative">
                <Button
                    variant="normal"
                    size="sm"
                    class="gap-1.5"
                    onclick={() => (scopeMenuOpen = !scopeMenuOpen)}
                >
                    <FolderClosed class="w-3 h-3" />
                    {scopeLabel(scope, itemsQuery.data ?? [])}
                    <ChevronDown class="w-3 h-3 opacity-60" />
                </Button>
                {#if scopeMenuOpen}
                    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                    <div
                        class="fixed inset-0 z-30"
                        onclick={() => (scopeMenuOpen = false)}
                    ></div>
                    <div
                        class="absolute left-0 top-full mt-1 z-40 min-w-[180px] bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-lg shadow-xl py-1"
                    >
                        <Button
                            variant="ghost"
                            size="sm"
                            class="w-full !justify-start rounded-none"
                            onclick={() => setScope({ kind: "all" })}
                        >All notes</Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            class="w-full !justify-start rounded-none"
                            onclick={() => {
                                scopeMenuOpen = false;
                                showNotePicker = true;
                            }}
                        >Single note…</Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            class="w-full !justify-start rounded-none"
                            onclick={() => {
                                scopeMenuOpen = false;
                                showFolderPicker = true;
                            }}
                        >Folder…</Button>
                        {#if scope.kind !== "all"}
                            <div class="h-px bg-[var(--stroke)] my-1"></div>
                            <Button
                                variant="ghost"
                                size="sm"
                                class="w-full !justify-start rounded-none text-[var(--text-dim)]"
                                onclick={() => setScope({ kind: "all" })}
                            >
                                <X class="w-3 h-3 mr-1" /> Clear scope
                            </Button>
                        {/if}
                    </div>
                {/if}
            </div>

            <SegmentedControl
                options={TYPE_CHIPS}
                value={typeFilter}
                onChange={(id) => setTypeFilter(id as FileTypeFilter)}
            />
        </div>

        {#if storage === "loading"}
            <div class="h-1.5 w-full bg-[var(--surface-raised)] rounded-full overflow-hidden animate-pulse"></div>
        {:else if storage === "error"}
            <div class="flex items-center gap-2 mt-1">
                <div class="text-xs font-mono text-[var(--text-dim)]">Storage unavailable</div>
                <Button variant="ghost" size="sm" aria-label="Refresh storage" onclick={refreshStorage} class="!p-1 !h-auto !min-w-0">
                    <RefreshCw class="w-3 h-3 text-[var(--text-dim)]" />
                </Button>
            </div>
        {:else}
            {@const effTrashed = effectiveTrashedBytes(storage.breakdown.trashed_bytes, trashSize)}
            {@const filesPct = storage.storage_quota > 0 ? Math.min(100, (storage.breakdown.files_bytes / storage.storage_quota) * 100) : 0}
            {@const itemsPct = storage.storage_quota > 0 ? Math.min(100, (storage.breakdown.items_bytes / storage.storage_quota) * 100) : 0}
            {@const historyPct = storage.storage_quota > 0 ? Math.min(100, (storage.breakdown.history_bytes / storage.storage_quota) * 100) : 0}
            {@const trashPct = storage.storage_quota > 0 ? Math.min(100, (effTrashed / storage.storage_quota) * 100) : 0}
            {@const isOverLimit = filesPct + itemsPct + historyPct + trashPct > 90}
            <div>
                <div class="h-1.5 w-full bg-[var(--surface-raised)] rounded-full overflow-hidden flex">
                    <div class="h-full transition-all {isOverLimit ? 'bg-red-500' : 'bg-blue-500'}" style="width: {filesPct}%" title="Files: {humanSizeShort(storage.breakdown.files_bytes)}"></div>
                    <div class="h-full transition-all {isOverLimit ? 'bg-red-500' : 'bg-brand0'}" style="width: {itemsPct}%" title="Notes & Folders: {humanSizeShort(storage.breakdown.items_bytes)}"></div>
                    <div class="h-full transition-all {isOverLimit ? 'bg-red-500' : 'bg-purple-500'}" style="width: {historyPct}%" title="History: {humanSizeShort(storage.breakdown.history_bytes)}"></div>
                    {#if trashPct > 0}
                        <div class="h-full bg-amber-500/60 transition-all" style="width: {trashPct}%" title="Trash: {humanSizeShort(effTrashed)}"></div>
                    {/if}
                </div>
                <div class="flex items-center gap-2 mt-1">
                    <span class="text-xs font-mono text-[var(--text-dim)]">{humanSizeShort(storage.breakdown.total_used)} / {humanSizeShort(storage.storage_quota)} used</span>
                    <Button variant="ghost" size="sm" aria-label="Refresh storage" onclick={refreshStorage} class="!p-1 !h-auto !min-w-0" title="Refresh storage usage">
                        <RefreshCw class="w-3 h-3 text-[var(--text-dim)]" />
                    </Button>
                    {#if effTrashed > 0}
                        <span class="text-xs font-mono text-[var(--text-dim)]">·</span>
                        <Button
                            variant="ghost"
                            size="sm"
                            onclick={() => goto("/trash")}
                            class="!text-xs font-mono !text-amber-500 hover:!text-amber-400 !h-auto !px-0"
                        >
                            {humanSizeShort(effTrashed)} in trash → open Trash
                        </Button>
                    {/if}
                </div>
            </div>
        {/if}

        <div class="flex items-center justify-between mt-4 border-t border-[var(--stroke)] pt-3 min-h-[2.625rem]">
            <div class="flex items-center gap-2">
                {#if selectedIds.size > 0}
                    <span class="text-xs font-mono text-[var(--text-muted)]">{selectedIds.size} selected</span>
                    <Button variant="normal" size="sm" class="flex-shrink-0" onclick={clearSelection}>Clear</Button>
                    <Button
                        variant="danger"
                        size="sm"
                        class="flex-shrink-0"
                        onclick={deleteSelected}
                        disabled={deleting}
                    >
                        {#if deleting}
                            <Loader2 class="w-[0.8125rem] h-[0.8125rem] animate-spin" /> Moving…
                        {:else}
                            <Trash2 class="w-[0.8125rem] h-[0.8125rem]" /> Move to trash ({selectedIds.size})
                        {/if}
                    </Button>
                {/if}
            </div>
            <div class="flex items-center bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-md px-2 py-1 ml-1">
                <select
                    bind:value={sortBy}
                    class="bg-transparent text-xs text-[var(--text-sub)] outline-none w-28 cursor-pointer [&>option]:bg-[var(--surface-panel)]"
                >
                    <option value="updated_desc">Newest first</option>
                    <option value="updated_asc">Oldest first</option>
                    <option value="size_desc">Largest first</option>
                    <option value="size_asc">Smallest first</option>
                    <option value="name_asc">Name (A-Z)</option>
                    <option value="type_asc">File type</option>
                </select>
            </div>
        </div>
    </div>

    {#if itemsQuery.isLoading}
        <div class="max-w-6xl w-full mx-auto px-3 sm:px-8 pt-2">
            <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                {#each Array(LOADING_SKELETON_COUNT) as _}
                    <div class="h-32 bg-[var(--surface-raised)] rounded-lg animate-pulse"></div>
                {/each}
            </div>
        </div>
    {:else if files.length === 0}
        <CollectionEmptyState
            icon={FileImage}
            title="No files yet"
            subtitle="Upload files from within a note."
        />
    {:else}
        <div class="flex-1 min-h-0" data-testid="files-grid">
            <VirtualFiles
                {files}
                {mode}
                onSelect={(f) => (selectedId = f.id)}
                {selectedIds}
                onToggle={toggleSelected}
            />
        </div>
    {/if}
</div>

{#if selected}
    <FileDetailPanel
        file={selected}
        onClose={() => (selectedId = null)}
        onChanged={() => {}}
    />
{/if}

{#if deleteDialog}
    {@const d = deleteDialog}
    <Dialog title="Delete {d.fileIds.length === 1 ? 'file' : d.fileIds.length + ' files'}?">
        {#snippet children()}
            <p class="text-xs text-[var(--text-muted)] mb-3">
                The {d.fileIds.length === 1 ? "file" : "files"} will be moved to trash. You can restore from there.
            </p>
        {/snippet}
        {#snippet footer()}
            <DialogActions>
                <Button onclick={() => (deleteDialog = null)}>Cancel</Button>
                <Button variant="danger" disabled={deleting} onclick={() => performDelete(d.fileIds)}>
                    Move to trash
                </Button>
            </DialogActions>
        {/snippet}
    </Dialog>
{/if}

{#if showNotePicker}
    <NotePickerModal
        title="Filter by note"
        onSelect={(noteId) => setScope({ kind: "note", id: noteId })}
        onClose={() => (showNotePicker = false)}
    />
{/if}

{#if showFolderPicker}
    <Dialog title="Filter by folder">
        {#snippet children()}
            <div class="max-h-64 overflow-y-auto flex flex-col gap-0.5">
                {#each folderOptions as folder (folder.id)}
                    <Button
                        variant="ghost"
                        size="sm"
                        class="!justify-start"
                        onclick={() => {
                            setScope({ kind: "folder", id: folder.id });
                            showFolderPicker = false;
                        }}
                    >
                        <FolderClosed class="w-3.5 h-3.5 mr-2 opacity-60" />
                        {folder.title}
                    </Button>
                {:else}
                    <p class="py-4 text-center text-xs text-[var(--text-dim)]">No folders yet</p>
                {/each}
            </div>
        {/snippet}
        {#snippet footer()}
            <DialogActions>
                <Button onclick={() => (showFolderPicker = false)}>Cancel</Button>
            </DialogActions>
        {/snippet}
    </Dialog>
{/if}