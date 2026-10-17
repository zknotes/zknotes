import { ItemService } from "$lib/core/services/item-service";
import { globalToasts } from "$lib/core/stores/toast.svelte";

export interface DuplicateNoteResult {
    itemId: string;
    strippedAttachments: number;
}

/**
 * Duplicates an item and shows a toast if attachments were left out. It does no rename, invalidation
 * or navigation — that is the caller's business (the ItemContextMenu default stays in the tree; the
 * onDuplicated callback navigates to the copy when the caller is tied to the note currently open, the
 * EditorHeader for instance).
 */
export async function duplicateNoteWithToast(itemId: string): Promise<DuplicateNoteResult | null> {
    try {
        const { item, strippedAttachments } = await ItemService.duplicateItem(itemId);
        if (strippedAttachments > 0) {
            globalToasts.add({
                variant: "info",
                message:
                    strippedAttachments === 1
                        ? "Note duplicated. 1 attachment was not copied — re-add it in the new note."
                        : `Note duplicated. ${strippedAttachments} attachments were not copied — re-add them in the new note.`,
                durationMs: 8000,
            });
        }
        return { itemId: item.id, strippedAttachments };
    } catch (e) {
        console.error("Failed to duplicate item", e);
        return null;
    }
}
