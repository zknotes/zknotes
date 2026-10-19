<script lang="ts">
import { runWithToast } from "$lib/core/stores/toast.svelte";
import {
    CloudOff,
    FileCode,
    History,
    ImageOff,
    MoreHorizontal,
    Paperclip,
    Save,
    Share2,
    Star,
} from "lucide-svelte";
import { useQueryClient } from "@tanstack/svelte-query";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { ItemService } from "$lib/core/services/item-service";
import { calcInsertSortOrder } from "$lib/core/utils/fractional-index";
import { pendingRenameId } from "$lib/core/stores/pending-rename.svelte";
import { goto } from "$app/navigation";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import type { BreadcrumbSegment } from "$lib/core/utils/tree";
import Button from "$lib/core/ui/Button.svelte";
import Dialog from "$lib/core/ui/Dialog.svelte";
import DialogActions from "$lib/core/ui/DialogActions.svelte";
import ItemContextMenu from "$lib/core/ui/ItemContextMenu.svelte";
import { Eyebrow } from "$lib/core/ui";
import type { NoteAutosave } from "$lib/modules/notes/NoteAutosave.svelte";
import SourceViewDialog from "./SourceViewDialog.svelte";

let {
    breadcrumb,
    autosave,
    noteId,
    attachmentCount = 0,
    inlineExternalImageCount = 0,
    promotingInline = false,
    starred = false,
    isTogglingStar = false,
    autoRename = false,
    showHistory = false,
    version = 1,
    onStar,
    onCommitRename,
    onToggleHistory,
    onShare,
    onPromoteInlineImages,
    getSourceHtml,
    sourceReady = false,
}: {
    breadcrumb: BreadcrumbSegment[];
    autosave: NoteAutosave;
    noteId: string;
    /** The number of encFile references in the editor — it links to /files?scope=note:… */
    attachmentCount?: number;
    /** TipTap image nodes (URL/base64) that are not vault files. */
    inlineExternalImageCount?: number;
    /** An "Add to Files" is in progress. */
    promotingInline?: boolean;
    starred?: boolean;
    isTogglingStar?: boolean;
    autoRename?: boolean;
    showHistory?: boolean;
    /** The item's server version — for the "local only" badge (version=1 + dirty). */
    version?: number;
    onStar: () => void;
    onCommitRename: (itemId: string, title: string) => void;
    onToggleHistory?: () => void;
    onShare?: () => void;
    /** A best-effort vault of the remote/inline image nodes. */
    onPromoteInlineImages?: () => void | Promise<void>;
    /**
     * The current note's HTML (`editor.getHTML()`). It returns null while the editor is not ready (a
     * note transition, or a destroyed editor) — View source is disabled then. It is called only on a
     * click, never during a render (it must not run per keystroke).
     */
    getSourceHtml?: () => string | null;
    /** A guard from the parent that avoids `getHTML()` — the same condition as the callback, cheap to render. */
    sourceReady?: boolean;
} = $props();

// "Never pushed to the server" — the version stays 1 until a push confirms server version 2.
const isLocalOnly = $derived(version === 1 && !!autosave.isDirty);

let inlineImagesDialogOpen = $state(false);

async function onAddToFilesFromDialog() {
    if (!onPromoteInlineImages) return;
    await onPromoteInlineImages();
    // The count refreshes in the parent; when it reaches 0, the $effect closes the dialog.
}

// If the problem disappears (a successful vault), close the dialog.
$effect(() => {
    if (inlineExternalImageCount === 0) inlineImagesDialogOpen = false;
});

const queryClient = useQueryClient();

let showMenuCrumbId = $state<string | null>(null);
let contextMenuPos = $state({ x: 0, y: 0 });

const contextMenuNode = $derived.by(() => {
    if (!showMenuCrumbId) return null;
    const items = queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems) || [];
    let n = items.find((i) => i.id === showMenuCrumbId);
    if (!n) {
        const c = breadcrumb.find((x) => x.id === showMenuCrumbId);
        // A fallback in case it is somehow not in the cache
        n = { id: showMenuCrumbId, type: c?.type ?? "folder", title: c?.title } as any;
    }
    return n;
});

// The shortcuts / "This note" / View source are for the note currently open only (a folder crumb shares the menu).
const isCurrentNoteMenu = $derived(
    !!contextMenuNode && contextMenuNode.type === "note" && contextMenuNode.id === noteId,
);

let sourceViewOpen = $state(false);
let sourceHtml = $state("");

function openSourceView() {
    showMenuCrumbId = null;
    const html = getSourceHtml?.() ?? null;
    if (html == null) return;
    sourceHtml = html;
    sourceViewOpen = true;
}

function handleItemClick(e: MouseEvent, crumb: { id: string; title: string }) {
    e.stopPropagation();

    // A second click on the same trigger, while the menu is already open for that item, closes it —
    // without this, clicking "..." while the popup is open would merely reopen the same menu.
    if (showMenuCrumbId === crumb.id) {
        showMenuCrumbId = null;
        return;
    }

    document.body.click(); // close the others

    contextMenuPos = {
        x: e.clientX,
        y: e.clientY + 15,
    };
    showMenuCrumbId = crumb.id;
}

async function createContextItem(type: "note" | "folder", parentId: string) {
    showMenuCrumbId = null;
    const items = queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems) || [];
    const fakeNode = { id: parentId, type: "folder" } as any;
    const { parentId: targetParentId, sortOrder } = calcInsertSortOrder(fakeNode, items);

    try {
        const item = await ItemService.createItem(
            type,
            targetParentId,
            type === "folder" ? "New Folder" : "Untitled",
            sortOrder,
        );
        // A breadcrumb create: open the path in the tree so the rename is visible even on a collapsed branch.
        if (targetParentId) {
            const { revealFolderInTree } = await import("$lib/core/utils/reveal-in-tree");
            revealFolderInTree(targetParentId, items);
        }
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        // The rename only after goto — otherwise the tree input loses the race against the editor (the same bug as the sidebar menu).
        if (type === "note") {
            await goto(`/note/${item.id}`, { keepFocus: true });
        }
        pendingRenameId.set(item.id);
    } catch (e) {
        console.error("Failed to create context item", e);
    }
}

async function handleDelete(itemId: string | null) {
    if (!itemId) return;
    showMenuCrumbId = null;

    await runWithToast(async () => {
        await ItemService.deleteItem(itemId);
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        await goto("/", { keepFocus: true });
    }, "Could not move the item to trash");
}

let renamingItemId = $state<string | null>(null);
let renameValue = $state("");
let renameOriginal = "";

// Cancel a rename when the note changes — it mirrors the reset in +page.svelte (that one stayed an
// $effect because it also does async work alongside the reset; here it is a pure state reset, so it
// uses .pre). .pre rather than $effect: no DOM reads and no async work, so it runs before the DOM
// patch and avoids a redundant second render cycle.
$effect.pre(() => {
    noteId; // tracked
    renamingItemId = null;
    sourceViewOpen = false;
    sourceHtml = "";
    showMenuCrumbId = null;
});

// Open the rename automatically for freshly created notes, once the breadcrumb is ready.
let autoRenameFired = $state(false);
$effect(() => {
    if (autoRename && !autoRenameFired && breadcrumb.length > 0) {
        autoRenameFired = true;
        const last = breadcrumb[breadcrumb.length - 1];
        if (last) startRename(last);
    }
});

function startRename(crumb: { id: string; title: string }) {
    renameValue = crumb.title || "Untitled";
    renameOriginal = crumb.title || "Untitled";
    renamingItemId = crumb.id;
}

function commitRename() {
    if (!renamingItemId) return;
    const id = renamingItemId;
    renamingItemId = null;
    const trimmed = renameValue.trim() || "Untitled";
    if (trimmed !== renameOriginal) onCommitRename(id, trimmed);
}

function focusInput(node: HTMLInputElement) {
    requestAnimationFrame(() => {
        node.focus();
        node.select();
    });
}
</script>

<svelte:window onclick={() => { showMenuCrumbId = null; }} />

<div
    data-testid="editor-header"
    class="relative z-30 h-12 border-b border-[var(--stroke)] px-5 flex items-center gap-3 bg-[var(--float-bg)] backdrop-blur-sm flex-shrink-0"
>
    <div class="flex items-center gap-1.5 text-xs text-[var(--text-dim)] min-w-0 flex-1">
        {#each breadcrumb as crumb, i (i)}
            {#if i > 0}
                <span class="text-[var(--text-dim)]">/</span>
            {/if}
            {#if renamingItemId === crumb.id}
                <input
                    type="text"
                    use:focusInput
                    bind:value={renameValue}
                    class="bg-[var(--surface-raised)] text-[var(--text)] font-medium rounded px-1.5 py-0.5 text-xs outline-none border border-brand0/50 focus:border-brand-fg min-w-0 max-w-[260px]"
                    onblur={commitRename}
                    onkeydown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                        if (e.key === "Escape") { renamingItemId = null; }
                        e.stopPropagation();
                    }}
                />
            {:else}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <span
                    class="truncate font-medium select-none flex items-center gap-1.5 {i === breadcrumb.length - 1 ? 'text-[var(--text-sub)] cursor-pointer' : 'hover:text-[var(--text-sub)] cursor-pointer text-[var(--text-dim)]'}"
                    title={i === breadcrumb.length - 1 ? "Double-click to rename, click for options" : "Click for options"}
                    ondblclick={(e) => { e.stopPropagation(); showMenuCrumbId = null; startRename(crumb); }}
                    onclick={(e) => { 
                        handleItemClick(e, crumb); 
                    }}
                    style={crumb.color ? `color: ${crumb.color}` : ''}
                >
                    {#if crumb.icon}<span class="emoji-icon text-xs leading-none mb-0.5">{crumb.icon}</span>{/if}
                    <span>{crumb.title}</span>
                </span>
            {/if}
        {/each}
        {#if breadcrumb.length === 0}
            <span class="text-[var(--text-dim)]">Untitled</span>
        {/if}
    </div>

    <div class="flex items-center gap-2 mr-2">
        <!-- The autosave status — the text is hidden on narrow screens to save space, while the dot
             (the colour/pulse) stays the only indicator; the full status remains in the title tooltip. -->
        <Eyebrow
            class="flex items-center gap-1.5 !tracking-wider {autosave.isDirty ? '!text-amber-400/80' : ''}"
            title={autosave.isSaving ? "saving…" : autosave.isDirty ? "unsaved" : "saved"}
        >
            <span class="w-1.5 h-1.5 rounded-full {autosave.isDirty ? 'bg-amber-400 pulse-dot' : autosave.isSaving ? 'bg-amber-400 pulse-dot' : 'bg-brand-fg'}"></span>
            <span class="hidden md:inline">
                {#if autosave.isSaving}saving…{:else if autosave.isDirty}unsaved{:else}saved{/if}
            </span>
        </Eyebrow>
        {#if autosave.isDirty}
            <Button
                variant="ghost"
                size="icon"
                onclick={() => autosave.executeSave(noteId)}
                title="Save (Ctrl+S)"
                class="!w-6 !h-6 text-amber-400 hover:text-amber-200 hover:bg-amber-400/10"
            >
                <Save class="w-3.5 h-3.5" />
            </Button>
        {/if}

        <!-- "Local only" — the server has not confirmed this item yet (version=1 plus dirty) -->
        {#if isLocalOnly}
            <Eyebrow
                as="span"
                class="flex items-center gap-1 px-1.5 py-0.5 rounded !tracking-wider bg-amber-500/10 !text-amber-400/90 border border-amber-500/20"
                title="This note has never been confirmed by the server (version=1, dirty). It will sync automatically."
            >
                <CloudOff class="w-2.5 h-2.5" />
                local only
            </Eyebrow>
        {/if}
    </div>

    <div class="flex items-center gap-0.5">
        {#if attachmentCount > 0}
            <Button
                variant="ghost"
                size="sm"
                class="!text-xs font-mono mr-1"
                title="{attachmentCount} {attachmentCount === 1 ? 'attachment' : 'attachments'} — view in Files"
                onclick={() => goto(`/files?scope=note:${noteId}`)}
            >
                📎 {attachmentCount}
            </Button>
        {/if}
        {#if inlineExternalImageCount > 0}
            <Button
                variant="ghost"
                size="icon"
                class="mr-0.5 relative text-amber-400/90 hover:text-amber-300"
                title="{inlineExternalImageCount} image{inlineExternalImageCount === 1
                    ? ''
                    : 's'} not stored in Files — click for details"
                aria-label="{inlineExternalImageCount} inline images not in Files"
                onclick={() => (inlineImagesDialogOpen = true)}
            >
                <ImageOff class="w-3.25 h-3.25" />
                <span
                    class="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 rounded-full
                           bg-amber-500/90 text-[9px] font-mono font-semibold text-black
                           flex items-center justify-center leading-none"
                >
                    {inlineExternalImageCount > 9 ? "9+" : inlineExternalImageCount}
                </span>
            </Button>
        {/if}
        <Button
            variant="ghost"
            size="icon"
            class="hidden md:inline-flex"
            title="Version history"
            aria-label="Toggle version history"
            active={showHistory}
            onclick={onToggleHistory}
        >
            <History class="w-3.25 h-3.25" />
        </Button>
        <Button
            variant="ghost"
            size="icon"
            title={starred ? "Unstar" : "Star"}
            aria-label={starred ? "Unstar note" : "Star note"}
            onclick={onStar}
            disabled={isTogglingStar}
        >
            <!-- The colour goes on the icon, not the button: .btn-ghost:hover would otherwise override it to --text (white in dark) -->
            <Star
                class="w-3.25 h-3.25 {starred ? 'fill-current' : ''}"
                style={starred ? "color: var(--star-color)" : undefined}
            />
        </Button>
        <Button
            variant="ghost"
            size="icon"
            title="More"
            aria-label="Note actions"
            active={showMenuCrumbId === breadcrumb[breadcrumb.length - 1]?.id}
            onclick={(e) => {
                const last = breadcrumb[breadcrumb.length - 1];
                if (last) handleItemClick(e, last);
            }}
        >
            <MoreHorizontal class="w-3.25 h-3.25" />
        </Button>
        <div class="w-px h-4 bg-[var(--surface-raised)] mx-1"></div>
        <Button
            variant="normal"
            size="sm"
            class="!text-xs border border-[color-mix(in_srgb,var(--stroke)_50%,transparent)]"
            title="Share"
            onclick={() => onShare?.()}
        >
            <Share2 class="w-2.75 h-2.75" /> <span class="hidden md:inline">Share</span>
        </Button>
    </div>
</div>

{#if contextMenuNode}
    {@const activeId = showMenuCrumbId!}
    {#snippet noteMenuLeading()}
        <Button
            variant="ghost"
            class="ctx-item h-auto w-full justify-start px-2.5 py-1.5 font-normal"
            onclick={() => {
                showMenuCrumbId = null;
                onToggleHistory?.();
            }}
        >
            <History class="w-[0.8125rem] h-[0.8125rem] shrink-0" />
            <span>{showHistory ? "Hide history" : "Show history"}</span>
        </Button>
        {#if attachmentCount >= 1}
            <Button
                variant="ghost"
                class="ctx-item h-auto w-full justify-start px-2.5 py-1.5 font-normal"
                onclick={() => {
                    showMenuCrumbId = null;
                    goto(`/files?scope=note:${noteId}`);
                }}
            >
                <Paperclip class="w-[0.8125rem] h-[0.8125rem] shrink-0" />
                <span>Attachments ({attachmentCount})</span>
            </Button>
        {/if}
        <div class="ctx-divider"></div>
        <Eyebrow
            class="px-2.5 pt-1 pb-0.5 pointer-events-none select-none"
            data-testid="note-menu-section-label"
        >
            This note
        </Eyebrow>
    {/snippet}
    {#snippet noteMenuBeforeDanger()}
        <Button
            variant="ghost"
            class="ctx-item h-auto w-full justify-start px-2.5 py-1.5 font-normal"
            disabled={!sourceReady}
            onclick={() => openSourceView()}
        >
            <FileCode class="w-[0.8125rem] h-[0.8125rem] shrink-0" />
            <span>View source…</span>
        </Button>
    {/snippet}
    <ItemContextMenu
        node={contextMenuNode}
        x={contextMenuPos.x}
        y={contextMenuPos.y}
        showStar={false}
        leading={isCurrentNoteMenu ? noteMenuLeading : undefined}
        beforeDanger={isCurrentNoteMenu ? noteMenuBeforeDanger : undefined}
        onClose={() => showMenuCrumbId = null}
        onRename={() => {
            const c = breadcrumb.find(x => x.id === activeId);
            showMenuCrumbId = null; 
            if (c) startRename(c); 
        }}
        onDelete={() => handleDelete(activeId)}
        onCreateItem={(type) => createContextItem(type, activeId)}
        onDuplicated={async (itemId) => {
            await goto(`/note/${itemId}`, { keepFocus: true });
        }}
    />
{/if}

{#if sourceViewOpen}
    <SourceViewDialog html={sourceHtml} onClose={() => (sourceViewOpen = false)} />
{/if}

{#if inlineImagesDialogOpen && inlineExternalImageCount > 0}
    <Dialog
        title="Images not stored in Files"
        width="max-w-md"
        onBackdropClick={() => (inlineImagesDialogOpen = false)}
    >
        <div class="space-y-3 text-sm text-[var(--text-sub)]">
            <p>
                This note has
                <strong class="text-[var(--text)]"
                    >{inlineExternalImageCount}
                    {inlineExternalImageCount === 1 ? "image" : "images"}</strong
                >
                that display in the editor but are
                <strong class="text-[var(--text)]">not encrypted vault files</strong>
                (no info / crop / delete toolbar, not listed under Files).
            </p>
            <ul class="list-disc list-outside ml-4 space-y-1.5 text-[var(--text-muted)]">
                <li>
                    <span class="text-[var(--text-sub)]">Embedded (base64) images</span>
                    are moved into Files automatically when you open or paste the note.
                </li>
                <li>
                    <span class="text-[var(--text-sub)]">Images from a web address</span>
                    (e.g. pasted from a web page) are not shown: the app blocks content from other
                    sites, so a note cannot tell them when it is opened. Save the image and upload
                    it, or copy the image itself rather than its address.
                </li>
                <li>
                    You can also remove the image and re-insert it with
                    <strong class="text-[var(--text)]">drag &amp; drop</strong>
                    or the toolbar image upload.
                </li>
            </ul>
        </div>
        {#snippet footer()}
            <DialogActions>
                <Button variant="ghost" onclick={() => (inlineImagesDialogOpen = false)}>
                    Close
                </Button>
                {#if onPromoteInlineImages}
                    <Button
                        variant="primary"
                        disabled={promotingInline}
                        loading={promotingInline}
                        onclick={() => void onAddToFilesFromDialog()}
                    >
                        {promotingInline ? "Adding…" : "Add to Files"}
                    </Button>
                {/if}
            </DialogActions>
        {/snippet}
    </Dialog>
{/if}
