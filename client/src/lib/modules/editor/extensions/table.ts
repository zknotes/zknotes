import type { Editor } from "@tiptap/core";
import { TableView, Table as TiptapTable } from "@tiptap/extension-table";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import {
    pxInRange,
    TABLE_WIDTH_PCT as WIDTH_PCT,
    type TableBorderStyle,
    tableBorderStyle,
    tableColor,
} from "$lib/core/utils/table-attrs";

// The shared Table extension — one place of truth for the table's schema.
// It is consumed by the main editor (`resizable: true`) and by the read-only HistoryPreview
// (`resizable: false`), which is why an *extended base* is exported here rather than a configured instance.
//
// The validators and the "attribute → style" reconstruction live in `core/utils/table-attrs` — the
// share render and the HTML export (`modules/export`, which may not import this module) need them
// too. They are re-exported here so the editor's callers keep one import.
export {
    applyTablePropsFromAttr,
    applyTableWidthsFromAttr,
    type TableBorderStyle,
    tableBorderStyle,
    tableColor,
} from "$lib/core/utils/table-attrs";

/** `"60%"` → `"width: 60%"`; `null` when no width is set (= full width). */
export function tableWidthStyle(pct: string | null | undefined): string | null {
    return pct && WIDTH_PCT.test(pct) ? `width: ${pct}` : null;
}

/** `"width: 60%"` → `"60%"`; `null` when the style carries no valid percentage width. */
export function tableWidthFromStyle(style: string | null | undefined): string | null {
    const m = /width:\s*(\d{1,3}(?:\.\d+)?%)/i.exec(style ?? "");
    return m?.[1] ?? null;
}

/**
 * Applies the stored width to the `.tableWrapper` of every table in the **live** editor.
 *
 * Why the wrapper and not the `<table>`: TipTap's `TableView.updateColumns` *unconditionally* clears
 * `table.style.width` on every update (`node.attrs.style` only protects it from a px override when
 * every column is fixed, not from deletion). TipTap never touches the wrapper div, so it is the only
 * stable place. Serialised HTML (an export, a share, any non-ProseMirror render) does not go through
 * TableView, so the inline `style` from `renderHTML` does the job there on its own — without this walk.
 *
 * It is called from every editor that *displays* a table: the main editor and HistoryPreview.
 */
export function applyTableWidths(editor: Editor): void {
    editor.view.state.doc.descendants((node, pos) => {
        if (node.type.name !== "table") return true;
        const pct = tableWidthFromStyle(node.attrs.style as string | null);
        try {
            const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
            if (!dom) return true;
            if (pct) dom.style.width = pct;
            else dom.style.removeProperty("width");
        } catch (_) {}
        return true;
    });
}

// ── Table properties ───────────────────────────────────────────────────────────────────────────
//
// Borders and padding do NOT inherit in CSS, so they are written as custom properties on the
// `<table>` (`--tbl-*`), and `app.css` and the export CSS read them with a fallback to the default
// appearance. Custom properties do inherit, so a single write covers every cell, the header
// included.

/** The maximum caption length allowed — the value goes into the DOM, not into free-form HTML. */
const CAPTION_MAX = 200;

export function tableCaptionText(value: unknown): string | null {
    const s = String(value ?? "").trim();
    return s ? s.slice(0, CAPTION_MAX) : null;
}

/**
 * A node view that maintains the table's properties alongside the stock `TableView`.
 *
 * Why a custom one: the stock constructor overwrites `table.style.cssText` from `node.attrs.style`
 * (the width) **alone**, so the other properties would disappear in the live editor; `update()` does
 * not touch the style at all, so an attribute change would not be visible until a reload. The same
 * view draws the `<caption>` too.
 */
export class ZkTableView extends TableView {
    #caption: HTMLTableCaptionElement | null = null;

    constructor(
        node: PmNode,
        cellMinWidth: number,
        view?: EditorView,
        HTMLAttributes?: Record<string, unknown>,
    ) {
        super(node, cellMinWidth, view, HTMLAttributes);
        this.#applyProps(node);
    }

    override update(node: PmNode): boolean {
        const ok = super.update(node);
        if (ok) this.#applyProps(node);
        return ok;
    }

    /**
     * A `<tr>` lives INSIDE `contentDOM` (the tbody), so the stock `ignoreMutation` treats its
     * attributes as a content change and ProseMirror re-renders the row — wiping the live height
     * preview while the user drags a row boundary or a corner. The height is a purely presentational
     * attribute that comes from the node attributes on commit anyway, so its DOM mutation may be ignored.
     */
    override ignoreMutation(mutation: Parameters<TableView["ignoreMutation"]>[0]): boolean {
        const target = mutation.target as HTMLElement;
        if (mutation.type === "attributes" && target.nodeName === "TR") return true;
        return super.ignoreMutation(mutation);
    }

    #applyProps(node: PmNode): void {
        const s = this.table.style;
        // Individual properties, NOT `cssText` — the width and `min-width` are owned and written by
        // `updateColumns`, and must not be overwritten.
        const set = (prop: string, value: string | null) => {
            if (value === null) s.removeProperty(prop);
            else s.setProperty(prop, value);
        };
        const bw = pxInRange(node.attrs.borderWidth, 10);
        set("--tbl-bw", bw === null ? null : `${bw}px`);
        set("--tbl-bs", tableBorderStyle(node.attrs.borderStyle));
        set("--tbl-bc", tableColor(node.attrs.borderColor));
        const pad = pxInRange(node.attrs.cellPadding, 40);
        set("--tbl-pad", pad === null ? null : `${pad}px`);
        s.backgroundColor = tableColor(node.attrs.background) ?? "";

        const caption = tableCaptionText(node.attrs.caption);
        if (!caption) {
            this.#caption?.remove();
            this.#caption = null;
            return;
        }
        if (!this.#caption) {
            this.#caption = document.createElement("caption");
            // The caption has to be the table's first child (an HTML rule).
            this.table.insertBefore(this.#caption, this.table.firstChild);
        }
        if (this.#caption.textContent !== caption) this.#caption.textContent = caption;
    }
}

export const Table = TiptapTable.extend({
    parseHTML() {
        return [
            ...(this.parent?.() ?? []),
            // Without this, ProseMirror pushes the text from `<caption>` into a NEW table row (proven
            // by experiment: `<caption>X</caption>` → `<td>X</td>`), so every `getHTML → setContent`
            // round trip would corrupt the document. prosemirror-model does not bind an `ignore` rule
            // to a node (`gatherRules` sets `rule.node` only when there is no `ignore`), so it applies
            // globally.
            { tag: "caption", ignore: true },
        ];
    },

    addAttributes() {
        return {
            ...this.parent?.(),
            // The attribute is DELIBERATELY named `style`: @tiptap/extension-table looks at exactly
            // `node.attrs.style` (TableView → updateColumns → `hasUserWidth`) to decide whether it may
            // overwrite `table.style.width`. Under any other name the resize plugin would
            // wipe the user's width on every update. renderHTML serialises that same attribute, so the
            // export and the history preview get the width without a single extra walk.
            style: {
                default: null,
                parseHTML: (el) => {
                    const dom = el as HTMLElement;
                    // The new form is an inline style; `data-user-width` is legacy (pre-59) content.
                    const pct =
                        tableWidthFromStyle(dom.getAttribute("style")) ?? dom.dataset.userWidth;
                    return tableWidthStyle(pct);
                },
                renderHTML: (attrs) => {
                    const pct = tableWidthFromStyle(attrs.style as string | null);
                    if (!pct) return {};
                    // `data-user-width` exists purely for the share render — `sanitizeShareHtml`
                    // strips `style`, so /s/:id reconstructs the width from the attribute.
                    return { style: `width: ${pct}`, "data-user-width": pct };
                },
            },

            // Every property is its own attribute and emits its own `style` fragment; `mergeAttributes`
            // merges `style` per property (a Map), so the fragments do not clobber each other or the width.
            borderWidth: {
                default: null,
                parseHTML: (el) => pxInRange((el as HTMLElement).dataset.tblBw, 10),
                renderHTML: (attrs) => {
                    const v = pxInRange(attrs.borderWidth, 10);
                    return v === null ? {} : { style: `--tbl-bw: ${v}px`, "data-tbl-bw": `${v}` };
                },
            },
            borderStyle: {
                default: null,
                parseHTML: (el) => tableBorderStyle((el as HTMLElement).dataset.tblBs),
                renderHTML: (attrs) => {
                    const v = tableBorderStyle(attrs.borderStyle);
                    return v === null ? {} : { style: `--tbl-bs: ${v}`, "data-tbl-bs": v };
                },
            },
            borderColor: {
                default: null,
                parseHTML: (el) => tableColor((el as HTMLElement).dataset.tblBc),
                renderHTML: (attrs) => {
                    const v = tableColor(attrs.borderColor);
                    return v === null ? {} : { style: `--tbl-bc: ${v}`, "data-tbl-bc": v };
                },
            },
            background: {
                default: null,
                parseHTML: (el) => tableColor((el as HTMLElement).dataset.tblBg),
                renderHTML: (attrs) => {
                    const v = tableColor(attrs.background);
                    return v === null ? {} : { style: `background-color: ${v}`, "data-tbl-bg": v };
                },
            },
            cellPadding: {
                default: null,
                parseHTML: (el) => pxInRange((el as HTMLElement).dataset.tblPad, 40),
                renderHTML: (attrs) => {
                    const v = pxInRange(attrs.cellPadding, 40);
                    return v === null ? {} : { style: `--tbl-pad: ${v}px`, "data-tbl-pad": `${v}` };
                },
            },
            // The caption is serialised as a real `<caption>` element (see `renderHTML` below),
            // so it does NOT go into the output attribute here — it is only read back while parsing.
            caption: {
                default: null,
                parseHTML: (el) =>
                    tableCaptionText((el as HTMLElement).querySelector("caption")?.textContent),
                renderHTML: () => ({}),
            },
        };
    },

    renderHTML(props) {
        const out = this.parent?.(props);
        const caption = tableCaptionText(props.node.attrs.caption);
        if (!caption || !Array.isArray(out)) return out ?? ["table", props.HTMLAttributes, 0];
        // `["table", attrs, colgroup, ["tbody", 0]]` → the caption has to come immediately after the
        // attributes, before `<colgroup>` (HTML allows a caption only as a table's first child).
        const spec = out as unknown[];
        const table = spec[0] === "div" ? (spec[2] as unknown[]) : spec;
        table.splice(2, 0, ["caption", {}, caption]);
        return out;
    },
});
