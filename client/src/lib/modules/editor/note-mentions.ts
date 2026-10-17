import type { Editor } from "@tiptap/core";
import type { DecryptedItemMeta } from "$lib/core/data/items";

/** The notes that can be linked (the @ picker, the Link popover) — the current note excluded. */
export function filterLinkableNotes(
    items: DecryptedItemMeta[],
    currentNoteId: string | undefined,
    query: string,
    limit = 10,
): DecryptedItemMeta[] {
    const q = query.trim().toLowerCase();
    return items
        .filter(
            (n) =>
                n.type === "note" &&
                n.id !== currentNoteId &&
                (q === "" || n.title.toLowerCase().includes(q)),
        )
        .slice(0, limit);
}

/** Inserts a mention node at the cursor (replacing the selection if there is one). */
export function insertNoteMention(editor: Editor, note: { id: string; label: string }): void {
    editor
        .chain()
        .focus()
        .deleteSelection()
        .insertContent({
            type: "mention",
            attrs: { id: note.id, label: note.label },
        })
        .run();
}
