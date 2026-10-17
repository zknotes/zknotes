import type { Editor } from "@tiptap/core";
import { CellSelection, cellAround } from "@tiptap/pm/tables";

/**
 * Makes sure the menu has a **visible** target: when the selection is a plain `TextSelection` inside
 * a cell, it is promoted to a single-cell `CellSelection`.
 *
 * Without this, the toolbar route ("Table ▾" — the only way in on touch and on the keyboard) acts on
 * a cell the user is merely assuming. One cell deliberately, rather than a whole row or column: the
 * caret position cannot tell you which axis the user has in mind, and the row and column commands
 * act on the row or column containing that cell anyway.
 */
export function ensureCellSelection(editor: Editor): boolean {
    const { state } = editor;
    if (state.selection instanceof CellSelection) return true;
    const $cell = cellAround(state.selection.$from);
    if (!$cell) return false;
    const tr = state.tr.setSelection(new CellSelection($cell));
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
    return true;
}
