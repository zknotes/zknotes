<script lang="ts">
import { useQueryClient } from "@tanstack/svelte-query";
import { ChevronRight, FileText, Folder, FolderOpen, MoreHorizontal, Star } from "lucide-svelte";
import { tick } from "svelte";
import { slide } from "svelte/transition";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import { ItemService } from "$lib/core/services/item-service";
import { activeSidebarId } from "$lib/core/stores/active-sidebar-id.svelte";
import { pendingExpandId } from "$lib/core/stores/pending-expand.svelte";
import { pendingRenameId } from "$lib/core/stores/pending-rename.svelte";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { expandedFolders } from "$lib/core/utils/expanded-folders";
import { calcDropSortOrder, calcInsertSortOrder } from "$lib/core/utils/fractional-index";
import { getAncestor, isDescendantOf, type TreeNode } from "$lib/core/utils/tree";
import { treeDragState } from "$lib/core/utils/tree-drag-state";
import { findNextRowAfterDelete, getAdjacentRow } from "$lib/core/utils/tree-keyboard";
import Button from "./Button.svelte";
import FolderItem from "./FolderItem.svelte";
import ItemContextMenu from "./ItemContextMenu.svelte";

type FolderTreeNode = TreeNode & {
    color?: string;
    icon?: string;
    starred?: boolean;
    dirty?: boolean; // changed locally, awaiting a push
};

let { node, level = 0 }: { node: FolderTreeNode; level?: number } = $props();

const queryClient = useQueryClient();

let isActive = $derived(activeSidebarId.current === node.id || page.url.pathname.endsWith(node.id));

function getInitialExpanded() {
    if (typeof window === "undefined" || node.type !== "folder") return false;
    return expandedFolders.isExpanded(node.id);
}

let expanded = $state(getInitialExpanded());
let dragPosition = $state<"top" | "bottom" | "inside" | null>(null);
// How many levels to "outdent" if the mouse is dragged left during a drag (0 = a normal drop onto the node).
let outdentLevel = $state(0);
// The indent step in rem — it has to follow the `level * 0.75 + 0.5` rem padding below.
// It must not be a fixed px: the app's UI zoom scales the root font-size, so the indent has to scale
// with it (otherwise the drag-outdent gesture and the visible indentation drift apart).
const INDENT_REM = 0.75;
function indentPx(): number {
    if (typeof document === "undefined") return INDENT_REM * 16;
    return INDENT_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
}
let showContextMenu = $state(false);
let contextMenuPos = $state({ x: 0, y: 0 });

function handleContextMenu(e: MouseEvent) {
    document.body.click(); // Forcibly closes every other open menu by simulating a click on the background
    e.preventDefault();
    e.stopPropagation();

    contextMenuPos = {
        x: e.clientX,
        y: e.clientY,
    };
    showContextMenu = true;
}

let isRenaming = $state(false);
let renameValue = $state("");
/** True while autofocus is still trying to take the field — onblur must not commit the rename then. */
let renameFocusGuard = false;

function startRename() {
    renameValue = node.title ?? "";
    isRenaming = true;
    showContextMenu = false;
}

// Expand the folder automatically when a reveal needs the whole path (a new folder under a collapsed A/B/C, say)
$effect(() => {
    if (node.type === "folder" && pendingExpandId.has(node.id)) {
        pendingExpandId.consume(node.id);
        if (!expanded) {
            expanded = true;
            expandedFolders.expand(node.id);
        }
    }
});

// Enter rename mode automatically if this node was just created
$effect(() => {
    if (pendingRenameId.current === node.id) {
        pendingRenameId.set(null);
        tick().then(() => {
            // An instant scroll — a smooth animation steals or delays focus from the rename input.
            const row = document.querySelector(`[data-node-id="${node.id}"]`) as HTMLElement;
            row?.scrollIntoView({ block: "nearest" });
            startRename();
        });
    }
});

function handleRenameBlur() {
    // goto(/note/:id) and the editor's mount send a blur before autofocus arrives.
    if (renameFocusGuard) return;
    void finishRename();
}

async function finishRename() {
    if (!isRenaming) return;
    isRenaming = false;
    const newTitle = renameValue.trim();
    if (newTitle && newTitle !== node.title) {
        node.title = newTitle; // optimistically
        await ItemService.updateItemTitle(node.id, newTitle);
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
        if (node.type === "note") {
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.note(node.id) });
        }
    }
}

function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
        finishRename();
    } else if (e.key === "Escape") {
        isRenaming = false;
    }
}

async function handleDelete() {
    showContextMenu = false;

    const { nextNodeId, nextNodeType } = findNextRowAfterDelete(node.id, node.type);
    const nextRow = nextNodeId
        ? (document.querySelector(
              `.tree-item-row[data-node-id="${nextNodeId}"]`,
          ) as HTMLElement | null)
        : null;

    if (nextNodeId && nextRow) {
        activeSidebarId.set(nextNodeId);
        nextRow.focus();
    } else {
        activeSidebarId.set(null);
    }

    // Capture the open note and the live tree BEFORE the deletion — so we know whether the open note
    // is inside the subtree being deleted (a cascade) and can redirect it (otherwise it stays in the
    // editor although it is no longer in the tree).
    const openId = page.params.id;
    const treeBefore =
        queryClient.getQueryData<{ id: string; parent_id: string | null; type: string }[]>(
            QUERY_KEYS.treeItems,
        ) ?? [];

    await ItemService.deleteItem(node.id);
    await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.deletedItems });

    globalToasts.add({
        variant: "info",
        message: `${node.title || "Item"} moved to trash`,
        durationMs: 7000,
        action: {
            label: "Undo",
            onClick: async () => {
                await ItemService.restoreItem(node.id);
                await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
                void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.deletedItems });
            },
        },
    });

    // Redirect if the open note was deleted — directly (node === note) OR as a descendant of a deleted
    // folder (a cascade). Otherwise the note stays in the editor although it is no longer in the tree.
    const openTrashed =
        !!openId && (openId === node.id || isDescendantOf(openId, node.id, treeBefore));
    if (openTrashed) {
        if (nextNodeId && nextNodeType === "note") {
            await goto(`/note/${nextNodeId}`, { keepFocus: true });
        } else {
            await goto("/", { keepFocus: true });
        }
    }

    // An extra safeguard in case goto disturbs the focus anyway
    if (nextNodeId) {
        const el = document.querySelector(
            `.tree-item-row[data-node-id="${nextNodeId}"]`,
        ) as HTMLElement;
        el?.focus();
    }
}

async function createContextItem(type: "note" | "folder") {
    showContextMenu = false;

    if (node.type === "folder" && !expanded) toggle();

    const items = queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems) || [];
    const { parentId, sortOrder } = calcInsertSortOrder(node, items);

    try {
        const item = await ItemService.createItem(
            type,
            parentId,
            type === "folder" ? "New Folder" : "Untitled",
            sortOrder,
        );

        // parentId is typically this folder or its parent — expand the whole ancestor path.
        if (parentId) {
            const { revealFolderInTree } = await import("$lib/core/utils/reveal-in-tree");
            revealFolderInTree(parentId, items);
        }
        await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });

        // The rename only AFTER the navigation: otherwise the $effect focuses the input, goto(/note/:id)
        // mounts the editor and the focus ends up outside the field (it looks like a rename, but typing does nothing).
        if (type === "note") {
            await goto(`/note/${item.id}`, { keepFocus: true });
        }
        await tick();
        pendingRenameId.set(item.id);
    } catch (e) {
        console.error("Failed to create context item", e);
    }
}

function autofocus(el: HTMLInputElement) {
    renameFocusGuard = true;
    let inner = 0;
    const apply = () => {
        if (!el.isConnected) return;
        el.focus();
        el.select();
    };
    apply();
    // Context-menu New note: the editor or SvelteKit can take focus on the next frame.
    const outer = requestAnimationFrame(() => {
        apply();
        inner = requestAnimationFrame(() => {
            apply();
            renameFocusGuard = false;
        });
    });
    return {
        destroy() {
            cancelAnimationFrame(outer);
            cancelAnimationFrame(inner);
            renameFocusGuard = false;
        },
    };
}

function toggle() {
    if (node.type === "folder") {
        expanded = !expanded;
        // A deferred localStorage write — it does not block the UI thread on rapid clicking
        const next = expanded;
        setTimeout(() => expandedFolders.set(node.id, next), 0);
    } else if (node.type === "note") {
        goto(`/note/${node.id}`, { keepFocus: true });
    }
}

function handleDragStart(e: DragEvent) {
    if (e.dataTransfer) {
        e.dataTransfer.setData("text/plain", node.id);
        if (node.type === "note") {
            e.dataTransfer.setData("application/x-note-id", node.id);
        } else if (node.type === "folder") {
            e.dataTransfer.setData("application/x-folder-id", node.id);
        }
        e.dataTransfer.effectAllowed = "move";
    }
    treeDragState.hoveredId = node.id;
    treeDragState.baselineX = e.clientX;
    e.stopPropagation();
}

function handleDragOver(e: DragEvent) {
    // Ignore OS file drops (the Files type) — accept only a reorder of a sidebar item.
    if (e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

    const targetElement = e.currentTarget as HTMLElement;
    const rect = targetElement.getBoundingClientRect();
    const y = e.clientY - rect.top;

    // The outdent gesture: the baseline (treeDragState.baselineX) is reset ONLY when the hovered node
    // really changes — not on a dragover from some inner element of the row (the icon, the text),
    // otherwise every micro-movement of the mouse within the same row would reset the measurement.
    // When the row changes, each gets a fresh baseline, so the offset is not "dragged along" from a
    // row hovered earlier.
    if (treeDragState.hoveredId !== node.id) {
        treeDragState.hoveredId = node.id;
        treeDragState.baselineX = e.clientX;
    }
    const deltaX = treeDragState.baselineX - e.clientX; // positive = dragged left since entering this row
    const step = indentPx();
    const avoidInside = deltaX > step / 2; // on a root row too — dragging left means "sibling", not "inside"

    if (node.type === "folder" && !avoidInside) {
        if (y < rect.height * 0.25) dragPosition = "top";
        else if (y > rect.height * 0.75) dragPosition = "bottom";
        else dragPosition = "inside";
    } else {
        if (y < rect.height * 0.5) dragPosition = "top";
        else dragPosition = "bottom";
    }

    outdentLevel = avoidInside ? Math.max(0, Math.min(level, Math.round(deltaX / step))) : 0;
}

function handleDragLeave(_e: DragEvent) {
    dragPosition = null;
    outdentLevel = 0;
}

async function handleDrop(e: DragEvent) {
    const pos = dragPosition;
    const levels = outdentLevel;
    dragPosition = null;
    outdentLevel = 0;

    // Do not handle OS file drops here — they belong to the editor.
    if ((e.dataTransfer?.files.length ?? 0) > 0) return;

    e.preventDefault();
    e.stopPropagation();

    // A tree reorder (note/folder). The file drag source (application/x-file-id) was removed — a file
    // move goes through FileService / the Files UI, not through the dead tree drop path.
    const draggedId = e.dataTransfer?.getData("text/plain");
    if (!draggedId || !pos) return;
    // No nesting into itself. But a top/bottom hover OVER ITS OWN row is a legitimate — and the most
    // natural — way to trigger an outdent: you simply drag the mouse left without even changing
    // row, exactly as in Workflowy/Notion. So we block a self-hover only for "inside".
    if (draggedId === node.id && pos === "inside") return;

    try {
        const items = queryClient.getQueryData<DecryptedItemMeta[]>(QUERY_KEYS.treeItems) || [];

        // Outdent: instead of the hovered node as the target, use its ancestor `levels` levels up
        // (the drop then behaves as top/bottom relative to THAT ancestor, i.e. a sibling immediately
        // after or before its branch). If the ancestor fell inside the subtree being dragged, that
        // would create a cycle — so discard the outdent in that case and fall back to a normal drop
        // onto the hovered node.
        let effectiveTarget: DecryptedItemMeta | FolderTreeNode = node;
        if (pos !== "inside" && levels > 0) {
            const ancestor = getAncestor(node.id, levels, items);
            if (
                ancestor &&
                ancestor.id !== draggedId &&
                !isDescendantOf(ancestor.id, draggedId, items)
            ) {
                effectiveTarget = ancestor;
            }
        }

        const { newParentId, newSortOrder } = calcDropSortOrder(pos, effectiveTarget, items);

        if (newSortOrder) {
            await ItemService.updateItemOrder(draggedId, newParentId, newSortOrder);
            queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });

            if (pos === "inside") {
                expanded = true;
                expandedFolders.expand(node.id);
            }
        }
    } catch (err) {
        console.error("Drop failed", err);
    }
}

function handleRowClick(e: MouseEvent) {
    (e.currentTarget as HTMLElement)?.focus();
    activeSidebarId.set(node.id);
    if (node.type === "note") {
        goto(`/note/${node.id}`, { keepFocus: true });
    } else {
        toggle();
    }
}

function handleKeyDown(e: KeyboardEvent) {
    if (isRenaming) return;

    if (e.key === "F2") {
        e.preventDefault();
        startRename();
    } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        handleDelete();
    } else if (e.key === "Enter") {
        e.preventDefault();
        if (node.type === "folder") {
            toggle();
        } else {
            goto(`/note/${node.id}`, { keepFocus: true });
        }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? "down" : "up";
        const targetRow = getAdjacentRow(e.currentTarget as HTMLElement, dir);
        if (targetRow) {
            targetRow.focus();
            const nodeId = targetRow.dataset.nodeId;
            const nodeType = targetRow.dataset.nodeType;
            if (nodeId) activeSidebarId.set(nodeId);
            if (nodeType === "note" && nodeId) goto(`/note/${nodeId}`, { keepFocus: true });
        }
    } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (node.type === "folder") {
            if (!expanded) {
                toggle();
            } else {
                const targetRow = getAdjacentRow(e.currentTarget as HTMLElement, "down");
                if (targetRow) {
                    targetRow.focus();
                    const nodeId = targetRow.dataset.nodeId;
                    const nodeType = targetRow.dataset.nodeType;
                    if (nodeId) activeSidebarId.set(nodeId);
                    if (nodeType === "note" && nodeId) goto(`/note/${nodeId}`, { keepFocus: true });
                }
            }
        }
    } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (node.type === "folder" && expanded) {
            toggle();
        } else if (node.parent_id) {
            const parentRow = document.querySelector(
                `.tree-item-row[data-node-id="${node.parent_id}"]`,
            ) as HTMLElement;
            if (parentRow) {
                parentRow.focus();
                const nodeId = parentRow.dataset.nodeId;
                if (nodeId) activeSidebarId.set(nodeId);
            }
        }
    }
}

function handleMouseEnter() {
    if (node.type === "note") {
        queryClient.prefetchQuery({
            queryKey: QUERY_KEYS.note(node.id),
            queryFn: () => ItemService.getDecryptedItem(node.id),
        });
    }
}
</script>

<svelte:window onclick={() => showContextMenu = false} />

<div class="flex flex-col">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
        role="treeitem"
        aria-selected={isActive}
        draggable="true"
        tabindex="0"
        data-node-id={node.id}
        data-node-type={node.type}
        ondragstart={handleDragStart}
        ondragover={handleDragOver}
        ondragleave={handleDragLeave}
        ondrop={handleDrop}
        oncontextmenu={handleContextMenu}
        onmouseenter={handleMouseEnter}
        onkeydown={handleKeyDown}
        class="tree-item-row tree-row group {isActive ? 'active' : ''} {dragPosition === 'inside' ? 'drag-over' : ''} focus:outline-none focus:ring-1 focus:ring-brand0/40"
        style="padding-left: {level * INDENT_REM + 0.5}rem;"
        onclick={handleRowClick}
    >
        {#if dragPosition === 'top'}
            <div class="absolute top-0 right-0 h-0.5 bg-brand-fg z-10 pointer-events-none" style="left: {Math.max(0, level - outdentLevel) * INDENT_REM + 0.5}rem;"></div>
        {/if}
        {#if dragPosition === 'bottom'}
            <div class="absolute bottom-0 right-0 h-0.5 bg-brand-fg z-10 pointer-events-none" style="left: {Math.max(0, level - outdentLevel) * INDENT_REM + 0.5}rem;"></div>
        {/if}
        {#if node.type === 'folder'}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- Sizes in rem, not px, so they follow the app's UI zoom (the html font-size %). -->
            <div
                class="caret flex items-center justify-center shrink-0 w-[0.6875rem] h-[0.6875rem] {expanded ? 'open' : ''}"
                onclick={(e) => { e.stopPropagation(); toggle(); }}
            >
                <ChevronRight class="w-[0.6875rem] h-[0.6875rem]" />
            </div>
            <span class="flex-shrink-0 flex items-center justify-center text-brand-fg w-[0.8125rem] h-[0.8125rem]">
                {#if node.icon}
                    <span class="emoji-icon text-xs">{node.icon}</span>
                {:else if expanded}
                    <FolderOpen class="w-[0.8125rem] h-[0.8125rem]" />
                {:else}
                    <Folder class="w-[0.8125rem] h-[0.8125rem]" />
                {/if}
            </span>
        {:else}
            <span class="shrink-0 w-[0.6875rem] h-[0.6875rem]"></span>
            <span class="flex-shrink-0 flex items-center justify-center text-[var(--text-dim)] w-[0.8125rem] h-[0.8125rem]">
                {#if node.icon}
                    <span class="emoji-icon text-xs">{node.icon}</span>
                {:else}
                    <FileText class="w-[0.8125rem] h-[0.8125rem]" />
                {/if}
            </span>
        {/if}

        {#if isRenaming}
            <input
                type="text"
                bind:value={renameValue}
                onblur={handleRenameBlur}
                onkeydown={handleRenameKeydown}
                use:autofocus
                class="input w-full px-1.5 py-0 h-[1.375rem] text-sm focus:border-[var(--accent-color)]"
                onclick={(e) => e.stopPropagation()}
                ondblclick={(e) => e.stopPropagation()}
            />
        {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
                class="truncate flex-1 min-w-0 flex items-center gap-1"
                ondblclick={(e) => { if (node.type === 'note') { e.stopPropagation(); startRename(); } }}
            >
                <span
                    class="truncate"
                    class:font-semibold={node.type === 'folder'}
                    style={node.color ? `color: ${node.color}` : ''}
                >
                    {node.title}
                </span>
                {#if node.type === 'note' && node.starred}
                    <Star class="w-3 h-3 fill-current flex-shrink-0" style="color: var(--star-color)" />
                {/if}
                {#if node.dirty}
                    <!-- The "Not yet synced" badge — dirty is plaintext metadata -->
                    <span
                        class="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style="background-color: var(--dirty-color)"
                        title="Not yet synced"
                    ></span>
                {/if}
            </span>
        {/if}

        <Button
            variant="ghost"
            size="icon"
            class="!w-5 !h-5 ml-auto hover-reveal max-md:opacity-100 focus:opacity-100 text-[var(--text-dim)] shrink-0"
            onclick={(e) => { e.stopPropagation(); handleContextMenu(e); }}
        >
            <MoreHorizontal class="w-3.5 h-3.5" />
        </Button>
    </div>

    {#if expanded && node.children?.length > 0}
        <div transition:slide={{ duration: 80 }}>
            {#each node.children as child (child.id)}
                <FolderItem node={child} level={level + 1} />
            {/each}
        </div>
    {/if}
</div>

{#if showContextMenu}
    <ItemContextMenu
        {node}
        x={contextMenuPos.x}
        y={contextMenuPos.y}
        onClose={() => showContextMenu = false}
        onRename={startRename}
        onDelete={handleDelete}
        onCreateItem={createContextItem}
    />
{/if}

