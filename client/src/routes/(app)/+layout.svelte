<script lang="ts">
import { createQuery, useQueryClient } from "@tanstack/svelte-query";
import {
    FolderPlus,
    Lock,
    PanelLeftClose,
    PanelLeftOpen,
    PenLine,
    ShieldCheck,
} from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { goto, onNavigate } from "$app/navigation";
import { page } from "$app/state";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { QUICK_VIEWS, type QuickView, quickViewForPath } from "$lib/core/constants/views";
import { deletedItemsQueryOptions, treeItemsQueryOptions } from "$lib/core/data/item-queries";
import { countVisibleTrashItems, type DecryptedItemMeta } from "$lib/core/data/items";
import { loadOrBuildIndex } from "$lib/core/search";
import { ItemService } from "$lib/core/services/item-service";
import { performLogout, restoreSession } from "$lib/core/services/session-service";
import { activeSidebarId } from "$lib/core/stores/active-sidebar-id.svelte";
import { authStore } from "$lib/core/stores/auth-store.svelte";
import { type ConflictEntry, conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { captureExpectedVaultEmailOnArrival } from "$lib/core/stores/delete-vault-expected";
import { pendingRenameId } from "$lib/core/stores/pending-rename.svelte";
import { recentNotesStore } from "$lib/core/stores/recent-notes.svelte";
import { utilityReturnStore } from "$lib/core/stores/utility-return.svelte";
import { searchIndexStore } from "$lib/core/stores/search-index.svelte";
import { themeStore } from "$lib/core/stores/theme.svelte";
import { initStreamBridge } from "$lib/core/streaming/sw-bridge";
import { initServiceWorkerUpdate } from "$lib/core/services/sw-update";
import { createSyncScheduler } from "$lib/core/sync/scheduler";
import { getUnsyncedWork } from "$lib/core/sync/unsynced-work";
import { syncStore } from "$lib/core/sync/store.svelte";
import FolderTree from "$lib/core/ui/FolderTree.svelte";
import SearchBar from "$lib/core/ui/SearchBar.svelte";
import SearchDialog from "$lib/core/ui/SearchDialog.svelte";
import { pageTitle } from "$lib/core/utils/page-title";
import SyncStatus from "$lib/core/ui/SyncStatus.svelte";
import SidebarAppMenu from "$lib/core/ui/SidebarAppMenu.svelte";
import Button from "$lib/core/ui/Button.svelte";
import Dialog from "$lib/core/ui/Dialog.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";
import { uiZoomStore } from "$lib/core/stores/ui-zoom.svelte";
import SyncPanel from "./SyncPanel.svelte";
import ConflictInboxModal from "$lib/modules/sync/ConflictInboxModal.svelte";
import { calcInsertSortOrder } from "$lib/core/utils/fractional-index";
import { requestPersistentStorage } from "$lib/core/utils/persistent-storage";
import { revealFolderInTree } from "$lib/core/utils/reveal-in-tree";
import { createGlobalTreeKeyHandler } from "$lib/core/utils/tree-keyboard";
import { onFilesChanged, onNotesChanged } from "$lib/modules/files/files-changed-bus";
import { registerFilesBridge } from "$lib/modules/files/register-bridge";
import { loadPersisted, savePersisted, STORAGE_KEYS } from "$lib/core/utils/persisted";

let { children } = $props();

const queryClient = useQueryClient();

// The sidebar width: clamped to 160–600 (the same limits as in startResizing). Default 280.
// It is persisted in localStorage (cn_sidebar_width) — a per-browser layout preference.
const SIDEBAR_WIDTH_MIN = 160;
const SIDEBAR_WIDTH_MAX = 600;
const SIDEBAR_WIDTH_DEFAULT = 280;

function clampSidebarWidth(w: number): number {
    if (!Number.isFinite(w)) return SIDEBAR_WIDTH_DEFAULT;
    return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(w)));
}

function loadSidebarWidth(): number {
    const stored = loadPersisted<number>(STORAGE_KEYS.sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
    return clampSidebarWidth(stored);
}

let sidebarWidth = $state(loadSidebarWidth());
let isResizing = $state(false);
let sidebarOpen = $state(true);
let isMobile = $state(false);
let locked = $state(false);
let syncPanelOpen = $state(false);
let conflictInboxOpen = $state(false);
// Confirm the logout while IDB still holds a non-terminal pending upload.
let pendingUploadDialog = $state<{ count: number; kind: "uploads" | "unsynced" } | null>(null);

// The reactive counts from the tree items query
const treeItemsQuery = createQuery(() => ({
    ...treeItemsQueryOptions(),
    enabled: authStore.isVaultUnlocked,
}));

const deletedItemsQuery = createQuery(() => ({
    ...deletedItemsQueryOptions(),
    enabled: authStore.isVaultUnlocked,
}));

let starredCount = $derived(
    (treeItemsQuery.data ?? []).filter((i) => i.type === "note" && i.starred).length,
);
// The sidebar badge = the number of rows in /trash (the "all" filter): notes/folders + individually
// trashed files. Batch files (deleted along with a note) sit in the accordion under the note rather
// than as separate rows.
let trashCount = $derived(countVisibleTrashItems(deletedItemsQuery.data ?? []));
let filesCount = $derived((treeItemsQuery.data ?? []).filter((i) => i.type === "file").length);
// The counters next to the quick-access buttons; Recent has none.
let quickCounts = $derived<Record<QuickView["id"], number | null>>({
    starred: starredCount,
    trash: trashCount,
    recent: null,
    files: filesCount,
});

// The active view derived from the current route
let activeView = $derived(quickViewForPath(page.url.pathname)?.id ?? "notes");

// The utility return stack: the navigate helper + the live-note check from the tree query
utilityReturnStore.setNavigate((path, opts) => goto(path, opts));

$effect(() => {
    const items = treeItemsQuery.data;
    // null = not loaded yet → optimistically true (do not bounce to home during the load)
    utilityReturnStore.setNoteLiveCheck((id) => {
        if (items == null) return true;
        const item = items.find((i) => i.id === id);
        return item != null && item.type === "note";
    });
});

// Track SPA navigation for the return stack (X / the sidebar toggle close).
// untrack: onNavigate writes the $state stack — without it the effect both reads and writes it → an infinite loop.
$effect(() => {
    const path = page.url.pathname;
    untrack(() => utilityReturnStore.onNavigate(path));
});

// Clear activeSidebarId when the URL changes, so the URL dictates the selection
$effect(() => {
    const _ = page.url.pathname;
    activeSidebarId.set(null);
});

// A native Selection Range survives the SPA swap of the main content (the layout stays).
// A tree-row click goes through with keepFocus + user-select: none, so Chrome remaps the highlight
// onto the sidebar menu and the note chrome. It is cleared before and after the DOM update.
function clearDocumentTextSelection(): void {
    window.getSelection()?.removeAllRanges();
}
onNavigate(() => {
    clearDocumentTextSelection();
    return clearDocumentTextSelection;
});

function openOrCloseUtility(view: QuickView) {
    if (activeView === view.id) {
        utilityReturnStore.close();
    } else {
        void goto(view.path);
    }
}

function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
}

async function createItem(type: "note" | "folder") {
    try {
        const items = queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems) || [];
        const refId = activeSidebarId.current || page.params.id;
        const refItem = refId ? items.find((i) => i.id === refId) : undefined;
        const { parentId, sortOrder } = calcInsertSortOrder(refItem, items);

        const item = await ItemService.createItem(
            type,
            parentId,
            type === "folder" ? "New Folder" : "Untitled",
            sortOrder,
        );
        pendingRenameId.set(item.id);

        // The whole ancestor path (A/B/C), not just the parent — otherwise a new item stays hidden
        // under a collapsed ancestor and the rename is never seen.
        if (parentId) {
            revealFolderInTree(parentId, items);
        }

        activeSidebarId.set(item.id);

        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    } catch (e) {
        console.error("Failed to create item", e);
    }
}

// ── File invalidation bridge ──
// The ONLY place that invalidates queries on a file-lifecycle change. FileService publishes
// `filesChanged`; here they are translated into a TanStack invalidation. Components no longer call
// invalidateQueries for files by hand → that kills the whole "a forgotten invalidation" bug class.
$effect(() =>
    onFilesChanged(() => {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.deletedItems });
    }),
);
// Note-content changes (an embed strip/append during a move, say) → invalidate those note caches.
$effect(() =>
    onNotesChanged((noteIds) => {
        for (const id of noteIds) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.note(id) });
        }
    }),
);

// ── The sync engine + the SW stream bridge (the logic lives in $lib/sync/scheduler and $lib/streaming) ──

const scheduler = createSyncScheduler({
    onTreeChanged: (changedIds) => {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        // Keep deletedItems in step with treeItems: deleteItem/restore change both sets.
        // Without this invalidation the /trash page shows stale data after an SPA navigation.
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.deletedItems });
        // Invalidate the note content query for every updated item — the editor then shows the new
        // content without a reload. Without this the pull updates IDB while the editor keeps the old
        // copy.
        for (const id of changedIds) {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.note(id) });
        }
    },
});

initStreamBridge();

// Register the modules/files implementations on core/events/file-bridge (the dependency inversion) —
// core/* (the sync engine, the SW bridge, teardown, drag-drop) calls fileBridge instead of importing modules/*.
registerFilesBridge();

// The per-user maximum file size (users.max_file_size) — cached for synchronous upload checks.
void import("$lib/modules/files/limits").then((m) => m.refreshFileLimits());

// The 401/403 handler lives in the root +layout (handleUnauthorizedSession) — a vault teardown plus a redirect.

// The conflict inbox — it opens on a click on the amber row in the sidebar footer (conflictInboxOpen).

// The pending badge: when the number of queued mutations changes, an item has become or
// stopped being
// `dirty` → refetch the tree so the badge appears and disappears. The counter changes only on an
// enqueue or a drain (an offline edit, a failed or successful push), so ordinary online editing —
// where the count stays 0 — triggers no refetch.
$effect(() => {
    void syncStore.pendingCount;
    if (!authStore.isVaultUnlocked) return;
    // Debounced (query "perf 4"): pendingCount is itself already coalesced (store.svelte.ts), but a
    // bulk operation spanning more than one debounce window would otherwise still refetch the tree
    // once per intermediate value instead of once for the whole burst.
    const timer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    }, 100);
    return () => clearTimeout(timer);
});

onMount(() => {
    // matchMedia rather than a "resize" event: it catches the crossing of the breakpoint more
    // reliably (in devtools' "Responsive" mode, or during a fast window resize, the "resize" event can
    // go missing or arrive late, so isMobile stays stuck on the old value while the CSS
    // "hidden md:flex" changes correctly anyway — the result being that the sidebar button vanishes).
    const mobileQuery = window.matchMedia("(max-width: 767px)");
    isMobile = mobileQuery.matches;
    if (isMobile) {
        sidebarOpen = false;
    }

    recentNotesStore.init();

    scheduler.attach();

    initServiceWorkerUpdate();

    const onMobileChange = (e: MediaQueryListEvent) => {
        isMobile = e.matches;
    };
    mobileQuery.addEventListener("change", onMobileChange);

    // Set by the cleanup below. The unlock sequence awaits network and index work, and the layout
    // can unmount (logout, a route out of (app)) before it reaches startBackground() — the
    // scheduler refuses to start after stop(), and this flag stops the rest of the sequence too.
    let unmounted = false;
    // Settings → Delete vault may arrive with the vault's address in the fragment (from the account
    // area). The sign-in redirect below drops the fragment and the section never mounts while the
    // vault is locked, so the address is remembered here, before anything else touches the URL.
    captureExpectedVaultEmailOnArrival(window.location);
    (async () => {
        // The root +layout.svelte has already run restoreSession() in its onMount.
        if (!authStore.isVaultUnlocked) {
            goto("/login");
            return;
        }

        // Anti-eviction: request durable IDB persistence once after the unlock.
        void requestPersistentStorage();

        await scheduler.syncNow();
        if (unmounted) return;

        // Load the conflicts from IDB — the store is filled only when the sync engine detects a NEW
        // conflict (add()), so conflicts left from a previous session would be invisible without this
        // call.
        void conflictStore.loadAllConflicts();

        // A one-off cleanup of ghost file items whose server chunks no longer exist.
        // It runs here (in the layout) so it happens whichever page the user lands on.
        void (async () => {
            try {
                const { pruneBrokenFiles } = await import("$lib/modules/files/prune");
                const n = await pruneBrokenFiles();
                if (n > 0) queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
            } catch {}
        })();

        // Resume every offline upload left in the queue (none of them tied to a specific note).
        void import("$lib/modules/files/upload-manager").then((m) => {
            m.resumeAllPendingUploads();
        });

        searchIndexStore.startBuilding();
        try {
            await loadOrBuildIndex((built, total) => {
                searchIndexStore.setProgress(built, total);
            });
        } catch (e) {
            console.error("Search index init failed", e);
        } finally {
            searchIndexStore.markReady();
        }
        if (unmounted) return;

        scheduler.startBackground();
    })();

    return () => {
        unmounted = true;
        mobileQuery.removeEventListener("change", onMobileChange);
        scheduler.stop();
    };
});

async function handleLogout() {
    utilityReturnStore.clear();
    await performLogout();
    goto("/login");
}

function startResizing(_e: MouseEvent) {
    isResizing = true;
    document.body.style.cursor = "col-resize";

    const onMouseMove = (e: MouseEvent) => {
        if (!isResizing) return;
        const newWidth = e.clientX;
        if (newWidth >= SIDEBAR_WIDTH_MIN && newWidth <= SIDEBAR_WIDTH_MAX) {
            sidebarWidth = newWidth;
        }
    };

    const onMouseUp = () => {
        isResizing = false;
        document.body.style.cursor = "default";
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        // Save at the end of the drag, not on every mousemove — the same width survives a refresh.
        savePersisted(STORAGE_KEYS.sidebarWidth, clampSidebarWidth(sidebarWidth));
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
}

function pendingUploadLogoutMessage(n: number, kind: "uploads" | "unsynced"): string {
    if (kind === "unsynced") {
        const noun = n === 1 ? "change" : "changes";
        return `${n} ${noun} not yet synced. Logging out will leave ${n === 1 ? "it" : "them"} only on this device.`;
    }
    const noun = n === 1 ? "file upload" : "file uploads";
    const pronoun = n === 1 ? "it" : "them";
    return `${n} ${noun} still in progress. Logging out will cancel ${pronoun} and the data cannot be recovered.`;
}

async function confirmLogoutDespiteUploads() {
    pendingUploadDialog = null;
    locked = true;
    await handleLogout();
}

async function toggleLock() {
    if (locked) {
        locked = false;
        return;
    }
    if (pendingUploadDialog) return;
    const work = await getUnsyncedWork();
    if (work.uploadsActive > 0) {
        pendingUploadDialog = { count: work.uploadsActive, kind: "uploads" };
        return;
    }
    if (work.dirtyCount > 0) {
        pendingUploadDialog = { count: work.dirtyCount, kind: "unsynced" };
        return;
    }
    locked = true;
    await handleLogout();
}

const handleGlobalTreeKeyDown = createGlobalTreeKeyHandler({
    getRouteNoteId: () => page.params.id,
    getTreeItems: () => treeItemsQuery.data ?? [],
    onItemsChanged: async () => {
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.deletedItems });
    },
});

function handleGlobalKeyDown(e: KeyboardEvent) {
    // Ctrl/Cmd+Shift+Escape — lock the vault (a full logout), the same path as the sidebar's "lock" button
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "Escape") {
        e.preventDefault();
        if (pendingUploadDialog) return;
        if (!locked) {
            toggleLock();
        }
        return;
    }
    // Ctrl/Cmd+0 — reset the UI zoom to "Auto" (a safety net if the control becomes hard to reach)
    if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        uiZoomStore.set("auto");
        return;
    }
    handleGlobalTreeKeyDown(e);
}
</script>

<svelte:window onkeydown={handleGlobalKeyDown} />

<svelte:head>
    <title>{pageTitle("ZKnotes")}</title>
</svelte:head>

{#if authStore.isVaultUnlocked}
    <div class="flex h-screen w-full bg-[var(--surface-app)] bg-grid overflow-hidden text-[var(--text)]"
         style="--app-sidebar-w: {!isMobile && sidebarOpen ? sidebarWidth : 0}px">

        <!-- A fixed hamburger button for mobile — only while the sidebar is open (to close the overlay).
             When it is closed, opening goes through the in-flow topbar in <main> (the same as on desktop),
             so it does not overlap the page content (the EditorHeader breadcrumb, for instance). -->
        {#if isMobile && sidebarOpen}
            <Button
                variant="ghost"
                size="icon"
                onclick={toggleSidebar}
                class="fixed top-3 left-3 z-50 w-8 h-8 bg-[var(--float-bg)] backdrop-blur-sm border border-[var(--stroke-soft)] shadow-md"
                title="Close sidebar"
            >
                <PanelLeftClose class="w-4 h-4" />
            </Button>
        {/if}

        <!-- The backdrop for the mobile overlay -->
        {#if sidebarOpen && isMobile}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="fixed inset-0 bg-black/50 backdrop-blur-sm z-30"
                onclick={toggleSidebar}
            ></div>
        {/if}

        <!-- Sidebar -->
        <aside
            class="flex flex-col h-full bg-[var(--surface-panel)] z-40 shrink-0
                   {isMobile ? 'fixed inset-y-0 left-0 transition-transform duration-200' : 'relative'}"
            style="width: {sidebarWidth}px;
                   {isMobile && !sidebarOpen ? 'transform: translateX(-100%);' : ''}
                   {!isMobile && !sidebarOpen ? 'display: none;' : ''}"
        >
                <!-- The workspace switcher (the header) -->
                <div class="pr-3 pt-3 pb-2 flex items-center gap-2 shrink-0 {isMobile ? 'pl-14' : 'pl-3'}">
                    <span class="shrink-0 w-7 h-7 rounded-md bg-[var(--surface-raised)] flex items-center justify-center">
                        <img src="/zknotes-icon-v2.svg" width="20" height="20" alt="">
                    </span>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-mono tracking-tight truncate leading-none">
                            <span class="font-extrabold text-[var(--text)]">ZK</span><span class="font-light text-sky-400">notes</span>
                        </div>
                    </div>
                    {#if !isMobile}
                        <Button
                            variant="ghost"
                            size="icon"
                            onclick={toggleSidebar}
                            class="flex w-6 h-6 shrink-0"
                            title="Close sidebar"
                        >
                            <PanelLeftClose class="w-[0.8125rem] h-[0.8125rem]" />
                        </Button>
                    {/if}
                </div>

                <!-- Search -->
                <SearchBar />

                <!-- Quick access: Starred / Trash / Recent / Files — a fixed 2×2 grid, not flex-wrap
                     (on a wider sidebar flex-wrap used to collapse into 1 row × 4 columns).
                     The counter renders only when it is > 0 — an empty min-w slot ate space on a
                     narrow sidebar and truncated the labels to "St…" / "Tr…" while room remained. -->
                <div class="px-3 pb-2 grid grid-cols-2 gap-1">
                    {#each QUICK_VIEWS as view (view.id)}
                        {@const Icon = view.icon}
                        {@const isActive = activeView === view.id}
                        {@const count = quickCounts[view.id]}
                        <Button
                            variant="ghost"
                            size="sm"
                            active={isActive}
                            class="w-full !px-1.5 !gap-1 !justify-start min-w-0"
                            onclick={() => openOrCloseUtility(view)}
                            title={view.title}
                        >
                            <Icon class="w-3 h-3 shrink-0 {isActive ? view.activeIconClass : 'text-[var(--text-dim)]'}" />
                            <span class="truncate min-w-0">{view.label}</span>
                            {#if count != null && count > 0}
                                <span
                                    class="font-mono text-2xs tabular-nums ml-auto shrink-0 text-right {isActive
                                        ? view.activeCountClass
                                        : 'text-[var(--text-dim)]'}"
                                >
                                    {count}
                                </span>
                            {/if}
                        </Button>
                    {/each}
                </div>

                <!-- The notes section's header + the create buttons -->
                <div class="px-3 pb-1.5 flex items-center gap-1">
                    <span class="text-2xs font-mono uppercase tracking-[0.18em] text-[var(--text-dim)] flex-1">Notes</span>
                    <Button
                        variant="ghost"
                        size="icon"
                        onclick={() => createItem('note')}
                        title="New note"
                        class="w-6 h-6 rounded-md bg-brand0/10 text-brand-fg"
                    >
                        <PenLine class="w-[0.6875rem] h-[0.6875rem]" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onclick={() => createItem('folder')}
                        title="New folder"
                        class="w-6 h-6 rounded-md border border-[var(--stroke-soft)] bg-[var(--surface-raised)] text-[var(--text-muted)]"
                    >
                        <FolderPlus class="w-[0.6875rem] h-[0.6875rem]" />
                    </Button>
                </div>

                <div class="h-px bg-[var(--stroke)] mx-3 mb-1"></div>

                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    data-testid="folder-tree"
                    class="flex-1 overflow-y-auto px-2 py-1 space-y-1 w-full min-h-0"
                    onclick={(e) => {
                        if (e.target === e.currentTarget) {
                            activeSidebarId.set(null);
                        }
                    }}
                >
                    <FolderTree />
                </div>

                <!-- The status footer (the Vault lock indicator) -->
                <div class="border-t border-[var(--stroke)] bg-[var(--surface-app)] shrink-0">
                    {#if conflictStore.allConflicts.length > 0}
                        <Button
                            variant="ghost"
                            title="View unresolved conflicts"
                            onclick={() => (conflictInboxOpen = true)}
                            class="w-full !h-auto !justify-start gap-2 rounded-none border-b border-amber-500/20 bg-amber-500/10 hover:bg-amber-500/18 text-left px-3 py-1.5"
                        >
                            <span class="flex h-1.5 w-1.5 relative shrink-0">
                                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500"></span>
                            </span>
                            <span class="text-xs font-mono font-medium text-amber-300 flex-1">
                                {conflictStore.allConflicts.length} {conflictStore.allConflicts.length === 1 ? 'conflict' : 'conflicts'} to resolve
                            </span>
                            <span class="text-2xs text-amber-400/70 shrink-0">Review →</span>
                        </Button>
                    {/if}
                    <div class="px-3 py-2 flex items-center gap-2">
                        <div
                            class="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 {locked
                                ? 'bg-amber-500/15 text-amber-300'
                                : 'bg-brand0/15 text-brand-fg'}"
                        >
                            {#if locked}
                                <Lock class="w-3 h-3" />
                            {:else}
                                <ShieldCheck class="w-3 h-3" />
                            {/if}
                        </div>
                        <div class="flex-1 min-w-0">
                            <SyncStatus onOpen={() => (syncPanelOpen = true)} />
                        </div>
                        <div class="flex items-center gap-0.5">
                            <SidebarAppMenu />
                            <Button
                                variant="normal"
                                size="sm"
                                onclick={toggleLock}
                                class="text-2xs font-mono uppercase tracking-wider ml-0.5 h-auto px-1.5 py-0.5"
                                title="Lock vault & logout (Ctrl/Cmd+Shift+Esc)"
                            >
                                {locked ? 'unlock' : 'lock'}
                            </Button>
                        </div>
                    </div>
                </div>

                <!-- The resize handle (desktop only) -->
                {#if !isMobile}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                        class="absolute top-0 right-0 w-[0.0625rem] h-full cursor-col-resize z-20 sidebar-resizer"
                        class:dragging={isResizing}
                        onmousedown={startResizing}
                    ></div>
                {/if}
            </aside>

        <!-- The main content area -->
        <main class="flex-1 flex flex-col relative h-full bg-[var(--surface-app)] bg-grid overflow-hidden min-w-0">
            <!-- The topbar (hamburger) — visible when the sidebar is collapsed, on desktop and mobile alike.
                 On mobile this replaces a fixed floating button — which would otherwise cover the
                 page content, the EditorHeader breadcrumb and actions for instance — with an in-flow
                 solution identical to the desktop variant. -->
            {#if !sidebarOpen}
                <div class="h-12 flex items-center px-4 border-b border-[var(--stroke)] shrink-0 relative z-10 bg-[var(--float-bg)] backdrop-blur-sm">
                    <Button
                        variant="ghost"
                        size="icon"
                        onclick={toggleSidebar}
                        title="Open sidebar"
                    >
                        <PanelLeftOpen class="w-5 h-5" />
                    </Button>
                    <div class="ml-2 flex items-center gap-2">
                        <span class="w-[1.625rem] h-[1.625rem] rounded-md bg-[var(--surface-raised)] flex items-center justify-center">
                            <img src="/zknotes-icon-v2.svg" width="18" height="18" alt="">
                        </span>
                        <span class="text-sm font-mono tracking-tight leading-none">
                            <span class="font-extrabold text-[var(--text)]">ZK</span><span class="font-light text-sky-400">notes</span>
                        </span>
                    </div>
                </div>
            {/if}

            <!-- Offline banner -->
            {#if !syncStore.isOnline}
                <div class="flex items-center justify-center gap-2 px-4 py-1.5 bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-xs font-medium shrink-0 z-20">
                    <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
                    Offline — changes will sync when the connection is restored
                    {#if syncStore.pendingCount > 0}
                        <span class="font-mono text-amber-200/90">· {syncStore.pendingCount} pending</span>
                    {/if}
                </div>
            {/if}

            <div class="flex-1 min-h-0 overflow-y-auto relative">
                {@render children()}
            </div>
        </main>
    </div>

    <SearchDialog />

    <SyncPanel open={syncPanelOpen} onClose={() => (syncPanelOpen = false)} />

    {#if conflictInboxOpen}
        <ConflictInboxModal onClose={() => (conflictInboxOpen = false)} />
    {/if}

    {#if pendingUploadDialog}
        {@const n = pendingUploadDialog.count}
        <Dialog title={pendingUploadDialog.kind === "unsynced" ? "Unsynced changes" : "Uploads in progress"}>
            <p class="text-xs text-[var(--text-muted)] mb-3">
                {pendingUploadLogoutMessage(n, pendingUploadDialog.kind)}
            </p>
            {#snippet footer()}
                <DialogActions>
                    <Button onclick={() => (pendingUploadDialog = null)}>Cancel</Button>
                    <Button variant="danger" onclick={confirmLogoutDespiteUploads}>
                        Log out anyway
                    </Button>
                </DialogActions>
            {/snippet}
        </Dialog>
    {/if}
{/if}

