<!-- UX DEBT: the context-menu items are raw <button>s — they should go through the MenuItem component. -->
<script lang="ts">
import type { Snippet } from "svelte";
import { useQueryClient } from "@tanstack/svelte-query";
import {
    Cloud,
    CloudDownload,
    Copy,
    FolderPlus,
    Pencil,
    PenLine,
    Star,
    Trash2,
    Folder,
    FileText,
} from "lucide-svelte";
import { FOLDER_PRESET_COLORS, FOLDER_PRESET_ICONS } from "$lib/core/constants/folder-presets";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { pinManager } from "$lib/core/files/pin-manager-state.svelte";
import { ItemService } from "$lib/core/services/item-service";
import { duplicateNoteWithToast } from "$lib/core/services/duplicate-note";
import { pendingRenameId } from "$lib/core/stores/pending-rename.svelte";

let {
    node,
    x,
    y,
    onClose,
    onRename,
    onDelete,
    onCreateItem,
    onDuplicated,
    showStar = true,
    leading,
    beforeDanger,
}: {
    node: {
        id: string;
        type: string;
        title?: string;
        color?: string;
        icon?: string;
        starred?: boolean;
    };
    x: number;
    y: number;
    onClose: () => void;
    onRename: () => void;
    onDelete: () => void;
    onCreateItem?: (type: "note" | "folder") => void;
    /** Called after a successful duplicate, with the copy's ID. Without it the menu stays in the tree (the default);
     * a caller that shows ONLY the note currently open (the editor header, say) uses it to navigate to the copy. */
    onDuplicated?: (itemId: string) => void | Promise<void>;
    /** The header instance turns Star off because it has a dedicated toggle. The sidebar keeps the default, true. */
    showStar?: boolean;
    /** The shortcuts and the section label come from the caller — copy does not live in core/ui. */
    leading?: Snippet;
    /** The items above "Move to trash" (View source, for instance) — copy does not live in core/ui. */
    beforeDanger?: Snippet;
} = $props();

const queryClient = useQueryClient();

// Unknown until it has actually been measured (bind:clientWidth/Height) — while it is undefined the
// menu stays hidden (visibility:hidden), which avoids a "jump" in its position: an assumed size
// (240×340) used to be used here for clamping against the screen edge, so the moment the real one
// (~470-500px, say, because of the icon/colour grid) was measured the position changed abruptly —
// visually it looked as though the menu "shrank" as it opened.
let menuWidth = $state<number | undefined>(undefined);
let menuHeight = $state<number | undefined>(undefined);
let contextMenuPos = $state({ x: 0, y: 0 });
let measured = $state(false);

$effect(() => {
    // Only the FIRST measurement may set the position. Without this guard, every later (and even tiny)
    // change to clientWidth/clientHeight — the font finishing loading and reflowing
    // a millisecond or two after the first paint — it would recompute the clamped position and move an
    // ALREADY VISIBLE menu. Along the left edge (the sidebar) that is invisible, because the position
    // there does not depend on the menu's width; along the right edge (the note header, where the
    // button is always close to the screen edge) every width change moves finalX directly, which
    // made it look as though the menu "shrank" as it opened.
    if (measured) return;
    if (menuWidth === undefined || menuHeight === undefined) return;

    let finalX = x;
    let finalY = y;
    // .ctx-menu has max-height: calc(100vh - 20px); clamp against the height actually used (otherwise
    // a menu taller than the viewport pins at y=10 and its bottom goes off-screen with no scroll).
    const maxH = Math.max(0, window.innerHeight - 20);
    const h = Math.min(menuHeight, maxH);

    if (finalY + h > window.innerHeight) {
        finalY = Math.max(10, window.innerHeight - h - 10);
    }
    if (finalX + menuWidth > window.innerWidth) {
        finalX = Math.max(10, window.innerWidth - menuWidth - 10);
    }

    contextMenuPos = { x: finalX, y: finalY };
    measured = true;
});

function patchTreeItem(
    targetId: string,
    patch: Partial<{ color: string; icon: string; starred: boolean }>,
) {
    const items = queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems);
    if (!items) return;
    queryClient.setQueryData(
        QUERY_KEYS.treeItems,
        items.map((item) => (item.id === targetId ? { ...item, ...patch } : item)),
    );
    // Tell the Svelte subscriptions without an IDB refetch (setQueryData alone does not trigger a re-render).
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems, refetchType: "none" });
}

async function setIcon(icon: string) {
    const targetId = node.id;
    const next = node.icon === icon ? "" : icon;
    patchTreeItem(targetId, { icon: next });
    onClose();
    try {
        await ItemService.updateItemIcon(targetId, next);
        patchTreeItem(targetId, { icon: next });
    } catch (e) {
        console.error("Failed to update icon", e);
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    }
}

async function setColor(color: string) {
    const targetId = node.id;
    patchTreeItem(targetId, { color });
    onClose();
    try {
        await ItemService.updateItemColor(targetId, color);
        patchTreeItem(targetId, { color });
    } catch (e) {
        console.error("Failed to update color", e);
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    }
}

async function toggleStar() {
    const targetId = node.id;
    const next = !node.starred;
    patchTreeItem(targetId, { starred: next });
    onClose();
    try {
        await ItemService.updateItemStarred(targetId, next);
    } catch (e) {
        console.error("Failed to update starred", e);
        patchTreeItem(targetId, { starred: !next });
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    }
}

async function handleDuplicate() {
    const p = duplicateNoteWithToast(node.id);
    onClose();
    const result = await p;
    if (!result) return;
    await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    await onDuplicated?.(result.itemId);
    pendingRenameId.set(result.itemId);
}

function portalAction(element: HTMLElement) {
    document.body.appendChild(element);
    // Focus the first entry, for Tab / focus-visible testing (without a full keyboard menu).
    queueMicrotask(() => {
        element.querySelector<HTMLButtonElement>(".ctx-item")?.focus();
    });
    return {
        destroy() {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        },
    };
}
</script>

<svelte:window onclick={() => onClose()} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    use:portalAction
    bind:clientWidth={menuWidth}
    bind:clientHeight={menuHeight}
    class="ctx-menu fixed"
    style="top: {contextMenuPos.y}px; left: {contextMenuPos.x}px; z-index: 200; visibility: {measured ? 'visible' : 'hidden'};"
    onclick={(e) => e.stopPropagation()}
>
    <!-- The header: the item's name + icon -->
    <div class="px-2.5 pt-1.5 pb-1.5 flex items-center gap-2">
        <span class="flex-shrink-0 flex items-center justify-center w-[0.875rem] h-[0.875rem] {node.type === 'folder' ? 'text-brand-fg' : 'text-[var(--text-dim)]'}">
            {#if node.icon}
                <span class="emoji-icon text-sm">{node.icon}</span>
            {:else if node.type === 'folder'}
                <Folder class="w-[0.875rem] h-[0.875rem]" />
            {:else}
                <FileText class="w-[0.875rem] h-[0.875rem]" />
            {/if}
        </span>
        <div class="text-xs font-semibold text-[var(--text)] truncate" style={node.color ? `color: ${node.color}` : ''}>
            {node.title || (node.type === "folder" ? "Folder" : "Untitled")}
        </div>
    </div>

    <div class="ctx-divider"></div>

    {#if leading}
        {@render leading()}
    {/if}

    <!-- Folders only: the creation actions -->
    {#if node.type === 'folder' && onCreateItem}
        <button type="button" class="ctx-item" onclick={() => { onCreateItem('note'); onClose(); }}>
            <PenLine class="w-[0.8125rem] h-[0.8125rem] shrink-0" /><span>New note</span>
        </button>
        <button type="button" class="ctx-item" onclick={() => { onCreateItem('folder'); onClose(); }}>
            <FolderPlus class="w-[0.8125rem] h-[0.8125rem] shrink-0" /><span>New folder</span>
        </button>
        <div class="ctx-divider"></div>
    {/if}

    <!-- The shared actions -->
    <button type="button" class="ctx-item" onclick={() => { onRename(); onClose(); }}>
        <Pencil class="w-[0.8125rem] h-[0.8125rem] shrink-0" /><span>Rename</span>
    </button>
    {#if node.type === 'note'}
        <button type="button" class="ctx-item" onclick={handleDuplicate}>
            <Copy class="w-[0.8125rem] h-[0.8125rem] shrink-0" /><span>Duplicate</span>
        </button>
        {#if showStar}
            <button type="button" class="ctx-item" onclick={toggleStar}>
                <Star
                    class="w-[0.8125rem] h-[0.8125rem] shrink-0 {node.starred ? 'fill-current' : ''}"
                    style={node.starred ? "color: var(--star-color)" : undefined}
                /><span>{node.starred ? "Unstar" : "Star"}</span>
            </button>
        {/if}
    {/if}

    <div class="ctx-divider"></div>

    <!-- The icon picker -->
    <div class="px-2.5 py-1.5">
        <div class="grid grid-cols-8 gap-0.5">
            {#each FOLDER_PRESET_ICONS as icon}
                <button
                    type="button"
                    class="emoji-icon w-6 h-6 rounded flex items-center justify-center text-sm transition-colors {node.icon === icon ? 'bg-[var(--accent-glow)] ring-1 ring-inset ring-[var(--accent-color)]' : 'hover:bg-[var(--row-hover)]'}"
                    onclick={() => setIcon(icon)}
                    title={icon}
                >{icon}</button>
            {/each}
        </div>
    </div>

    <!-- The colour picker (folders only) -->
    {#if node.type === 'folder'}
        <div class="ctx-divider"></div>
        <div class="px-2.5 py-1.5">
            <div class="flex gap-1 flex-wrap">
                {#each FOLDER_PRESET_COLORS as c}
                    <button
                        class="w-4 h-4 rounded-full hover:scale-110 transition-transform {node.color === c ? 'ring-2 ring-offset-1 ring-[var(--text)]' : ''}"
                        style="background-color: {c};"
                        onclick={() => setColor(c)}
                        title={c}
                    ></button>
                {/each}
                <button
                    class="w-4 h-4 rounded-full hover:scale-110 transition-transform flex items-center justify-center {!node.color ? 'ring-2 ring-offset-1 ring-[var(--text)]' : ''}"
                    style="border: 1px solid var(--text-dim); background: linear-gradient(to top right, transparent calc(50% - 1px), var(--text-dim) calc(50% - 1px), var(--text-dim) calc(50% + 1px), transparent calc(50% + 1px));"
                    onclick={() => setColor('')}
                    title="Remove color"
                ></button>
            </div>
        </div>
    {/if}

    <div class="ctx-divider"></div>

    <!-- Selective Sync (Pinning) -->
    {#if pinManager.isPinned(node.id)}
        <button type="button" class="ctx-item" onclick={() => { pinManager.unpinItem(node.id); onClose(); }}>
            <Cloud class="w-[0.8125rem] h-[0.8125rem] shrink-0 text-[var(--text-muted)]" /><span>Remove from device</span>
        </button>
    {:else}
        <button type="button" class="ctx-item" onclick={() => { pinManager.pinItem(node.id); onClose(); }}>
            <CloudDownload class="w-[0.8125rem] h-[0.8125rem] shrink-0 text-[var(--text-muted)]" /><span>Keep on this device</span>
        </button>
    {/if}

    {#if beforeDanger}
        <div class="ctx-divider"></div>
        {@render beforeDanger()}
    {/if}

    <div class="ctx-divider"></div>

    <button type="button" class="ctx-item danger" onclick={() => { onDelete(); onClose(); }}>
        <Trash2 class="w-[0.8125rem] h-[0.8125rem] shrink-0" /><span>Move to trash</span>
    </button>
</div>
