/**
 * The shared Table extension: a width survives serialisation and a re-parse, a legacy
 * `data-user-width` is migrated, and the resize plugin does not overwrite the user's width.
 */
import { Editor } from "@tiptap/core";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { applyTableWidths, Table, tableWidthFromStyle, tableWidthStyle } from "./table";
import { TableRow } from "./table-row";

function makeEditor(content: string, resizable: boolean): Editor {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return new Editor({
        element: el,
        extensions: [StarterKit, Table.configure({ resizable }), TableRow, TableHeader, TableCell],
        content,
    });
}

const TABLE = (attrs: string) => `
  <table ${attrs}>
    <tr><th>H</th><th>H2</th></tr>
    <tr><td>a</td><td>b</td></tr>
  </table>
`;

describe("shared Table extension", () => {
    const editors: Editor[] = [];

    afterEach(() => {
        while (editors.length) editors.pop()?.destroy();
        document.body.innerHTML = "";
    });

    it("tableWidthStyle and tableWidthFromStyle are inverses and reject junk", () => {
        expect(tableWidthStyle("60%")).toBe("width: 60%");
        expect(tableWidthStyle("60px")).toBeNull();
        expect(tableWidthStyle("url(evil)")).toBeNull();
        expect(tableWidthStyle(null)).toBeNull();
        expect(tableWidthFromStyle("width: 60%")).toBe("60%");
        expect(tableWidthFromStyle("width: 33.5%")).toBe("33.5%");
        expect(tableWidthFromStyle("color: red")).toBeNull();
        expect(tableWidthFromStyle(undefined)).toBeNull();
    });

    it("an inline style width survives a round trip through getHTML", () => {
        const editor = makeEditor(TABLE(`style="width: 60%"`), true);
        editors.push(editor);
        const html = editor.getHTML();
        // The table is left-aligned, with no auto margin.
        expect(html).toContain('style="width: 60%;"');
        expect(html).not.toContain("margin-left: auto");
        // `data-user-width` exists for the share render, which strips `style`.
        expect(html).toContain('data-user-width="60%"');
    });

    it("a legacy data-user-width is migrated into style", () => {
        const editor = makeEditor(TABLE(`data-user-width="45%"`), true);
        editors.push(editor);
        expect(editor.getHTML()).toContain('style="width: 45%;"');
    });

    it("a row height survives a round trip through getHTML", () => {
        const editor = makeEditor(`<table><tr style="height: 48px"><td>a</td></tr></table>`, false);
        editors.push(editor);
        const html = editor.getHTML();
        expect(html).toContain('style="height: 48px;"');
        // `data-user-height` exists for the share render, which strips `style`.
        expect(html).toContain('data-user-height="48px"');
    });

    it("the legacy path: a row height is also read from data-user-height", () => {
        const editor = makeEditor(
            `<table><tr data-user-height="60px"><td>a</td></tr></table>`,
            false,
        );
        editors.push(editor);
        expect(editor.getHTML()).toContain('style="height: 60px;"');
    });

    it("a table with no width gets neither a style nor a data-user-width", () => {
        const editor = makeEditor(TABLE(""), true);
        editors.push(editor);
        const html = editor.getHTML();
        expect(html).not.toContain("data-user-width");
        // TipTap still emits its own `min-width` — but not the user's `width`.
        expect(/style="[^"]*[^-]width:/.test(html)).toBe(false);
    });

    it("the live editor applies the width to .tableWrapper (TableView clears table.style.width)", () => {
        const editor = makeEditor(TABLE(`style="width: 60%"`), true);
        editors.push(editor);
        const table = editor.view.dom.querySelector("table") as HTMLElement;
        const wrapper = editor.view.dom.querySelector(".tableWrapper") as HTMLElement;
        expect(wrapper).toBeTruthy();
        // Proof of why the walk exists: TableView.updateColumns cleared the inline width from the <table>.
        expect(table.style.width).toBe("");

        applyTableWidths(editor);
        expect(wrapper.style.width).toBe("60%");
    });

    it("the read-only preview (resizable: false) uses the same walk", () => {
        const editor = makeEditor(TABLE(`style="width: 30%"`), false);
        editors.push(editor);
        applyTableWidths(editor);
        const wrapper = editor.view.dom.querySelector(".tableWrapper") as HTMLElement;
        expect(wrapper.style.width).toBe("30%");
    });

    it("applyTableWidths removes the width once the attribute is gone", () => {
        const editor = makeEditor(TABLE(`style="width: 60%"`), true);
        editors.push(editor);
        applyTableWidths(editor);
        const wrapper = editor.view.dom.querySelector(".tableWrapper") as HTMLElement;
        expect(wrapper.style.width).toBe("60%");

        editor.commands.setContent(TABLE(""));
        applyTableWidths(editor);
        const after = editor.view.dom.querySelector(".tableWrapper") as HTMLElement;
        expect(after.style.width).toBe("");
    });

    it("changing a row's height does not recreate the <tr> element (a live preview)", () => {
        const editor = makeEditor(`<table><tr><td>a</td></tr></table>`, false);
        editors.push(editor);
        const before = editor.view.dom.querySelector("tr") as HTMLElement;
        expect(before).toBeTruthy();

        const tablePos = 0;
        const table = editor.state.doc.nodeAt(tablePos);
        const row = table?.firstChild;
        expect(row).toBeTruthy();
        editor.view.dispatch(
            editor.state.tr.setNodeMarkup(tablePos + 1, undefined, {
                ...row?.attrs,
                style: "height: 90px",
            }),
        );

        const after = editor.view.dom.querySelector("tr") as HTMLElement;
        // The same element: `update()` returns true instead of ProseMirror replacing the row. Were it
        // replaced, the live height preview — which writes into `tr.style` — would vanish on every
        // drag.
        expect(after).toBe(before);
        expect(after.style.height).toBe("90px");
    });

    // ── Table properties ───────────────────────────────────────────────────────────────────

    it("the properties survive a round trip and do not clobber the width", () => {
        const editor = makeEditor(
            `<table style="width: 50%" data-tbl-bw="3" data-tbl-bs="dashed" data-tbl-bc="#ff0000"
                    data-tbl-bg="#eeeeee" data-tbl-pad="12"><tr><td>a</td></tr></table>`,
            false,
        );
        editors.push(editor);
        const html = editor.getHTML();
        for (const frag of [
            "--tbl-bw: 3px",
            "--tbl-bs: dashed",
            "--tbl-bc: #ff0000",
            // The serializer normalises a real CSS property into rgb(); custom properties stay literal.
            "background-color: rgb(238, 238, 238)",
            "--tbl-pad: 12px",
            "width: 50%",
        ]) {
            expect(html).toContain(frag);
        }
        // The data-* twins are the only route through the share sanitisation.
        expect(html).toContain('data-tbl-bw="3"');
        expect(html).toContain('data-tbl-pad="12"');
    });

    it("invalid property values are discarded", () => {
        const editor = makeEditor(
            `<table data-tbl-bw="999" data-tbl-bs="url(evil)" data-tbl-bc="red"
                    data-tbl-pad="-4"><tr><td>a</td></tr></table>`,
            false,
        );
        editors.push(editor);
        const html = editor.getHTML();
        expect(html).not.toContain("--tbl-bw");
        expect(html).not.toContain("--tbl-bs");
        expect(html).not.toContain("--tbl-bc");
        expect(html).not.toContain("--tbl-pad");
    });

    it("a caption survives a round trip and does NOT become a table row", () => {
        const editor = makeEditor(
            `<table><caption>My caption</caption><tr><td>a</td><td>b</td></tr></table>`,
            false,
        );
        editors.push(editor);
        const html = editor.getHTML();
        expect(html).toContain("<caption>My caption</caption>");
        // The key point: the caption's text must not end up in a cell (without the `ignore` rule ProseMirror
        // would push it into a new row).
        expect(html).not.toContain('<td colspan="1" rowspan="1"><p>My caption</p></td>');
        expect(editor.state.doc.firstChild?.childCount).toBe(1);
    });

    it("an empty caption emits no <caption>", () => {
        const editor = makeEditor(`<table><tr><td>a</td></tr></table>`, false);
        editors.push(editor);
        expect(editor.getHTML()).not.toContain("<caption>");
    });

    it("an invalid width is discarded while parsing", () => {
        const editor = makeEditor(TABLE(`style="width: 600px"`), true);
        editors.push(editor);
        expect(editor.getHTML()).not.toContain("data-user-width");
    });
});
