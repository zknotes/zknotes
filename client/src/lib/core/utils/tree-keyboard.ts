/**
 * Returns the next or previous .tree-item-row element relative to currentEl.
 */
export function getAdjacentRow(
    currentEl: HTMLElement,
    direction: "up" | "down",
): HTMLElement | undefined {
    const rows = Array.from(document.querySelectorAll(".tree-item-row")) as HTMLElement[];
    const idx = rows.indexOf(currentEl);
    if (idx === -1) return undefined;
    if (direction === "down") return rows[idx + 1];
    return rows[idx - 1];
}

/**
 * Finds which row should take the focus AFTER the given node is deleted:
 * - a note: the next one below, or the one above when there is none below
 * - a folder: the one above, so we do not select a child being deleted along with it
 */
export function findNextRowAfterDelete(
    nodeId: string,
    nodeType: string,
): { nextNodeId: string | undefined; nextNodeType: string | undefined } {
    const rows = Array.from(document.querySelectorAll(".tree-item-row")) as HTMLElement[];
    const currentIndex = rows.findIndex((row) => row.dataset.nodeId === nodeId);

    let nextRow: HTMLElement | undefined;

    if (currentIndex >= 0) {
        if (nodeType === "note") {
            nextRow =
                currentIndex < rows.length - 1
                    ? rows[currentIndex + 1]
                    : currentIndex > 0
                      ? rows[currentIndex - 1]
                      : undefined;
        } else {
            nextRow = currentIndex > 0 ? rows[currentIndex - 1] : undefined;
        }
    }

    return {
        nextNodeId: nextRow?.dataset.nodeId,
        nextNodeType: nextRow?.dataset.nodeType,
    };
}

// ── The global Delete/Alt+N handler (lifted out of (app)/+layout.svelte) ─────────

import { goto } from "$app/navigation";
import { ItemService } from "$lib/core/services/item-service";
import { activeSidebarId } from "$lib/core/stores/active-sidebar-id.svelte";
import { globalToasts } from "$lib/core/stores/toast.svelte";

export interface GlobalTreeKeyDeps {
    /** The note ID from the current route (page.params.id) — the layout passes it in. */
    getRouteNoteId: () => string | undefined;
    /** Invalidates the tree + deleted queries after a delete/undo. */
    onItemsChanged: () => Promise<void> | void;
}

/**
 * Global keyboard navigation for the tree:
 *  - Delete/Backspace: a soft-delete of the active item (with an Undo toast and the focus on
 *    the next row), except when the focus is in an input or the editor
 *  - Alt+N: toggles the focus between the tree and the editor
 */
export function createGlobalTreeKeyHandler(deps: GlobalTreeKeyDeps) {
    return async function handleGlobalKeyDown(e: KeyboardEvent) {
        if (e.key === "Delete" || e.key === "Backspace") {
            const active = document.activeElement;
            if (active) {
                const tagName = active.tagName;
                const isInput =
                    tagName === "INPUT" ||
                    tagName === "TEXTAREA" ||
                    active.hasAttribute("contenteditable") ||
                    active.closest("[contenteditable]");
                if (isInput) return;
            }

            const activeId = activeSidebarId.current || deps.getRouteNoteId();
            if (activeId) {
                e.preventDefault();

                const activeRow = document.querySelector(
                    `.tree-item-row[data-node-id="${activeId}"]`,
                ) as HTMLElement | null;
                const deletedNodeType = activeRow?.dataset.nodeType ?? "note";
                const { nextNodeId, nextNodeType } = findNextRowAfterDelete(
                    activeId,
                    deletedNodeType,
                );
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

                try {
                    // Read the node's title before the deletion
                    const itemEl = document.querySelector(
                        `.tree-item-row[data-node-id="${activeId}"]`,
                    ) as HTMLElement;
                    const nodeTitle =
                        itemEl?.querySelector(".truncate")?.textContent?.trim() || "Item";

                    await ItemService.deleteItem(activeId);
                    await deps.onItemsChanged();

                    globalToasts.add({
                        variant: "info",
                        message: `${nodeTitle} moved to trash`,
                        durationMs: 7000,
                        action: {
                            label: "Undo",
                            onClick: async () => {
                                await ItemService.restoreItem(activeId);
                                await deps.onItemsChanged();
                            },
                        },
                    });

                    if (deps.getRouteNoteId() === activeId) {
                        if (nextNodeId && nextNodeType === "note") {
                            await goto(`/note/${nextNodeId}`, { keepFocus: true });
                        } else {
                            await goto("/", { keepFocus: true });
                        }
                    }

                    // An extra safeguard
                    if (nextNodeId) {
                        const el = document.querySelector(
                            `.tree-item-row[data-node-id="${nextNodeId}"]`,
                        ) as HTMLElement;
                        el?.focus();
                    }
                } catch (err) {
                    console.error("Failed to delete item globally", err);
                }
            }
        } else if (e.altKey && e.key.toLowerCase() === "n") {
            e.preventDefault();
            const activeItem = document.querySelector(".tree-item-row.active") as HTMLElement;
            const firstItem = document.querySelector(".tree-item-row") as HTMLElement;
            const editor = document.querySelector(".ProseMirror") as HTMLElement;

            if (document.activeElement?.closest(".tree-item-row")) {
                // Currently in the navigation -> switch to the editor
                editor?.focus();
            } else {
                // Currently in the editor, or somewhere else -> switch to the navigation
                if (activeItem) {
                    activeItem.focus();
                } else if (firstItem) {
                    firstItem.focus();
                }
            }
        }
    };
}
