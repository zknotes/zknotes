/**
 * A mousedown in the empty space above or below a note's content (the wrapper's padding, the margin
 * of the first or last block — an image, say) should place the cursor at the start or the end: what
 * the user actually wants is to type before or after that block, not "nothing happens".
 * The handler has to sit on `mousedown`, not `click`: a drag-select whose mouseup lands in the
 * padding would otherwise collapse the highlight, because `click.target` is the common ancestor.
 *
 * When the first or last node is an atom (encFile, an image), we insert an empty paragraph so a real
 * text cursor is visible (not just the GapCursor's line). A repeated click into
 * an already-empty leading or trailing paragraph does not stack up new lines.
 */

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

export type EmptySpaceFocus = "start" | "end";

/**
 * A rect that measures the boundary of the "empty space" by a block's VISIBLE edge rather than by the DOM element that
 * happens to carry that rect.
 *
 * `.tableWrapper` (`overflow-x: auto`) is a new block formatting context, so the table's own
 * `margin: 1.2em 0` (`app.css`) does not collapse outside the wrapper but is absorbed into the
 * wrapper's OWN rect
 * — so the wrapper's rect physically covers space that looks empty. Without this, `topEdge` and
 * `bottomEdge` for a table would come out almost identical to the editor's edge (the margin absorbed),
 * so a click
 * into that space would never fall outside `[topEdge, bottomEdge]`. For every other block (an image,
 * an encFile, a paragraph…) the element's own rect holds — their margin collapses outwards normally.
 */
export function visualEdgeRect(el: Element): DOMRect {
    if (el.classList.contains("tableWrapper")) {
        const table = el.querySelector("table");
        if (table) return table.getBoundingClientRect();
    }
    return el.getBoundingClientRect();
}

/**
 * @param clientY  the click's Y coordinate (viewport)
 * @param topEdge  the top edge of the first content block (or of the whole ProseMirror)
 * @param bottomEdge the bottom edge of the last content block (or of the whole ProseMirror)
 * @returns "start" | "end" when the click is in the upper or lower empty band, otherwise null
 */
export function emptySpaceFocusFromY(
    clientY: number,
    topEdge: number,
    bottomEdge: number,
): EmptySpaceFocus | null {
    if (clientY < topEdge) return "start";
    if (clientY > bottomEdge) return "end";
    return null;
}

/**
 * The pointer is inside ProseMirror — the `.ProseMirror` root itself included.
 *
 * The root has to count as inside: the margin between a heading and a paragraph, and a `click` after
 * a drag-select across two blocks both have `target === pm` (the common ancestor). The old
 * `target !== pm` was therefore collapsing a heading+paragraph selection, while a single paragraph
 * (with the mousedown and mouseup on the same `<p>`) worked.
 */
export function isPointerInsideProseMirror(target: EventTarget | null, pm: HTMLElement): boolean {
    return target instanceof Node && pm.contains(target);
}

/**
 * A mousedown in the empty padding around the editor: the cursor goes to the start/end, or to a clamped
 * `posAtCoords`. Returns true when the event was handled.
 *
 * It has to listen on `mousedown`, not `click`. After a drag-select, `click.target` is
 * the common ancestor (the padding wrapper, or the `.ProseMirror` root when the selection spans a
 * heading and a paragraph) — `setTextSelection` would then collapse the highlight.
 * Events inside PM are left alone. A `click` with an already non-empty selection is ignored (a
 * safeguard in case someone accidentally binds onclick).
 */
export function handleEmptySpacePointer(editor: Editor, event: MouseEvent): boolean {
    if (editor.isDestroyed) return false;
    if (event.button !== 0) return false;

    const pm = editor.view.dom as HTMLElement;
    if (isPointerInsideProseMirror(event.target, pm)) return false;

    if (event.type === "click" && !editor.state.selection.empty) return false;

    const r = pm.getBoundingClientRect();
    const edge = emptySpaceFocusFromY(event.clientY, r.top, r.bottom);
    if (edge) {
        applyEmptySpaceFocus(editor, edge);
        return true;
    }

    const left = Math.min(Math.max(event.clientX, r.left + 1), r.right - 1);
    const top = Math.min(Math.max(event.clientY, r.top + 1), r.bottom - 1);
    const at = editor.view.posAtCoords({ left, top });
    if (at) editor.chain().setTextSelection(at.pos).focus().run();
    else editor.commands.focus("end");
    return true;
}

function isBlockAtom(node: PMNode): boolean {
    return node.isAtom && !node.isInline;
}

function isEmptyParagraph(node: PMNode): boolean {
    return node.type.name === "paragraph" && node.content.size === 0;
}

/**
 * `true` when a click on `node`'s edge must not rely on `.focus("start"/"end")`, because that
 * the command simply looks for the nearest VALID text position anywhere in the doc — for an atom
 * (which has no text) that is the wrong position, and for a table (whose first writable position is
 * inside the first cell, several levels deep) equally so: the user clicks above the note expecting the
 * start of a line, not to be teleported into a cell. The same principle holds for any future block
 * with no directly writable position on its own boundary — the confirmed cases (atoms, tables) are
 * covered here.
 */
function needsBoundaryParagraph(node: PMNode): boolean {
    return isBlockAtom(node) || node.type.name === "table";
}

/** Places a visible cursor at the start or the end; before or after an atom block → a new empty line. */
export function applyEmptySpaceFocus(editor: Editor, edge: EmptySpaceFocus): void {
    if (editor.isDestroyed) return;
    const { state, view } = editor;
    const { doc, schema } = state;
    const paragraphType = schema.nodes.paragraph;
    if (!paragraphType) {
        editor.chain().focus(edge).run();
        return;
    }

    if (edge === "start") {
        const first = doc.firstChild;
        if (first && isEmptyParagraph(first)) {
            editor.chain().focus("start").run();
            return;
        }
        if (first && needsBoundaryParagraph(first)) {
            const tr = state.tr.insert(0, paragraphType.create());
            tr.setSelection(TextSelection.create(tr.doc, 1));
            view.dispatch(tr);
            view.focus();
            return;
        }
        editor.chain().focus("start").run();
        return;
    }

    const last = doc.lastChild;
    if (last && isEmptyParagraph(last)) {
        editor.chain().focus("end").run();
        return;
    }
    if (last && needsBoundaryParagraph(last)) {
        const pos = doc.content.size;
        const tr = state.tr.insert(pos, paragraphType.create());
        tr.setSelection(TextSelection.create(tr.doc, pos + 1));
        view.dispatch(tr);
        view.focus();
        return;
    }
    editor.chain().focus("end").run();
}
