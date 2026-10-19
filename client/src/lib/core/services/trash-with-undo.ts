// Trashing the focused tree node with an Undo toast — one implementation for the row's context
// menu / Delete key (FolderItem) and the global Delete handler (tree-keyboard). The two used to
// carry their own copies and had drifted: the row redirected when the open note was anywhere inside
// a trashed folder, the global handler only when the trashed node itself was open, so Delete on a
// folder could leave a now-trashed child note sitting in the editor.
import { goto } from "$app/navigation";
import { ItemService } from "$lib/core/services/item-service";
import { activeSidebarId } from "$lib/core/stores/active-sidebar-id.svelte";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { isDescendantOf } from "$lib/core/utils/tree";
import { findNextRowAfterDelete } from "$lib/core/utils/tree-keyboard";

export interface TrashNodeOptions {
    id: string;
    type: string;
    /** Shown in the toast; falls back to "Item". */
    title: string | undefined;
    /** The note open in the editor (the route param), if any. */
    openNoteId: string | undefined;
    /** The live tree BEFORE the deletion — to tell whether the open note is inside the trashed subtree. */
    treeItems: readonly { id: string; parent_id: string | null }[];
    /** Invalidates the tree and trash queries; called after the deletion and after an Undo. */
    onItemsChanged: () => Promise<void> | void;
}

function focusTreeRow(nodeId: string): HTMLElement | null {
    const row = document.querySelector<HTMLElement>(`.tree-item-row[data-node-id="${nodeId}"]`);
    row?.focus();
    return row;
}

/** Moves the focus to the row that will take the deleted one's place and makes it the active row. */
function focusNextRowBeforeDelete(id: string, type: string) {
    const next = findNextRowAfterDelete(id, type);
    if (next.nextNodeId && focusTreeRow(next.nextNodeId)) {
        activeSidebarId.set(next.nextNodeId);
    } else {
        activeSidebarId.set(null);
    }
    return next;
}

export async function trashNodeWithUndo(opts: TrashNodeOptions): Promise<void> {
    const { nextNodeId, nextNodeType } = focusNextRowBeforeDelete(opts.id, opts.type);
    // Decided before the deletion: afterwards the subtree is no longer in the live tree.
    const openTrashed =
        !!opts.openNoteId &&
        (opts.openNoteId === opts.id || isDescendantOf(opts.openNoteId, opts.id, opts.treeItems));

    await ItemService.deleteItem(opts.id);
    await opts.onItemsChanged();

    globalToasts.add({
        variant: "info",
        message: `${opts.title || "Item"} moved to trash`,
        durationMs: 7000,
        action: {
            label: "Undo",
            onClick: async () => {
                await ItemService.restoreItem(opts.id);
                await opts.onItemsChanged();
            },
        },
    });

    // The open note left the tree — directly, or with the folder it was in. Leave the editor.
    if (openTrashed) {
        await goto(nextNodeId && nextNodeType === "note" ? `/note/${nextNodeId}` : "/", {
            keepFocus: true,
        });
    }

    // In case the navigation disturbed the focus.
    if (nextNodeId) focusTreeRow(nextNodeId);
}
