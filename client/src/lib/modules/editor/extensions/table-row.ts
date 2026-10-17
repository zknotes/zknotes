import TiptapTableRow from "@tiptap/extension-table-row";
import { ROW_HEIGHT_PX as HEIGHT_PX } from "$lib/core/utils/table-attrs";

// The shared TableRow extension — it carries the row height. It is consumed by the main editor
// and the read-only HistoryPreview, so an extended base is exported, exactly as in `table.ts`.
//
// The validator and the "attribute → style" reconstruction live in `core/utils/table-attrs` (the
// share render and the HTML export need them too); re-exported so the editor keeps one import.
export { applyRowHeightsFromAttr } from "$lib/core/utils/table-attrs";

/** `"48px"` → `"height: 48px"`; `null` when no height is set (= automatic). */
export function rowHeightStyle(px: string | null | undefined): string | null {
    return px && HEIGHT_PX.test(px) ? `height: ${px}` : null;
}

/** `"height: 48px"` → `"48px"`; `null` when the style carries no valid pixel height. */
export function rowHeightFromStyle(style: string | null | undefined): string | null {
    const m = /height:\s*(\d{1,4}px)/i.exec(style ?? "");
    return m?.[1] ?? null;
}

export const TableRow = TiptapTableRow.extend({
    /**
     * The custom node view exists for the **live height preview**.
     *
     * Without it: the preview writes `tr.style.height`, and a `<tr>` lives inside the table's
     * `contentDOM`, so ProseMirror sees that mutation as a content change and **replaces the whole
     * `<tr>`** (proven with a MutationObserver: `TBODY-CHILDLIST +1 -0 / +0 -1` after every write) —
     * so the gesture looks dead until the button is released. An `ignoreMutation` on the table does
     * not help: for a mutation on a `<tr>`
     * it is **that** node's desc that is asked, not the parent node view.
     */
    addNodeView() {
        return ({ node }) => {
            const dom = document.createElement("tr");

            const applyHeight = (n: typeof node) => {
                const px = rowHeightFromStyle(n.attrs.style as string | null);
                if (px) {
                    dom.style.height = px;
                    dom.dataset.userHeight = px;
                } else {
                    dom.style.removeProperty("height");
                    delete dom.dataset.userHeight;
                }
            };
            applyHeight(node);

            return {
                dom,
                contentDOM: dom,
                // The height is a presentational attribute — a DOM mutation must not tear the row down.
                ignoreMutation: (mutation: MutationRecord | { type: string }) =>
                    mutation.type === "attributes",
                update: (updated: typeof node) => {
                    if (updated.type !== node.type) return false;
                    applyHeight(updated);
                    return true;
                },
            };
        };
    },

    addAttributes() {
        return {
            ...this.parent?.(),
            // The attribute is named `style` for the same reason as on the table: it serialises
            // directly into the inline style, so the export and the history preview get the height
            // without an extra walk. Unlike the table, a `<tr>` has no node view to overwrite it.
            style: {
                default: null,
                parseHTML: (el) => {
                    const dom = el as HTMLElement;
                    const px =
                        rowHeightFromStyle(dom.getAttribute("style")) ?? dom.dataset.userHeight;
                    return rowHeightStyle(px);
                },
                renderHTML: (attrs) => {
                    const px = rowHeightFromStyle(attrs.style as string | null);
                    if (!px) return {};
                    // `data-user-height` exists purely for the share render — see above.
                    return { style: `height: ${px}`, "data-user-height": px };
                },
            },
        };
    },
});
