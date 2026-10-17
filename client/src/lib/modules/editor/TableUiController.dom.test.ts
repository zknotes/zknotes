/**
 * TableUiController: the hover state, the toolbar positions, syncSelection.
 */
import { Editor } from "@tiptap/core";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { CellSelection } from "@tiptap/pm/tables";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Table } from "./extensions/table";
import { TableRow } from "./extensions/table-row";
import { PopoverMenus } from "./PopoverMenus.svelte";
import { TableUiController } from "./TableUiController.svelte";
import { ensureCellSelection } from "./table-commands";

function makeTableEditor(
    content = `
          <table>
            <tr><th>H</th></tr>
            <tr><td>c</td></tr>
          </table>
        `,
): Editor {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return new Editor({
        element: el,
        extensions: [
            StarterKit,
            Table.configure({ resizable: false }),
            TableRow,
            TableHeader,
            TableCell,
        ],
        content,
    });
}

function fakeRect(left: number, top: number, width: number, height: number): DOMRect {
    return {
        top,
        left,
        right: left + width,
        bottom: top + height,
        width,
        height,
        x: left,
        y: top,
        toJSON: () => ({}),
    } as DOMRect;
}

describe("TableUiController", () => {
    const editors: Editor[] = [];

    afterEach(() => {
        while (editors.length) editors.pop()?.destroy();
        document.body.innerHTML = "";
        vi.useRealTimers();
    });

    beforeAll(() => {
        if (typeof window !== "undefined") {
            Object.defineProperty(window, "matchMedia", {
                writable: true,
                value: vi.fn().mockImplementation((query) => ({
                    matches: true,
                    media: query,
                    onchange: null,
                    addListener: vi.fn(),
                    removeListener: vi.fn(),
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn(),
                    dispatchEvent: vi.fn(),
                })),
            });
        }
    });

    it("a caret inside a table sets activeRect and the toolbar positions", () => {
        const editor = makeTableEditor();
        editors.push(editor);
        const scrollEl = document.createElement("div");
        Object.defineProperty(scrollEl, "scrollTop", { value: 100, configurable: true });
        Object.defineProperty(scrollEl, "scrollLeft", { value: 20, configurable: true });
        scrollEl.getBoundingClientRect = () => fakeRect(10, 50, 790, 550);

        const menus = new PopoverMenus();
        const ui = new TableUiController(
            menus,
            () => editor,
            () => scrollEl,
        );
        const prose = editor.view.dom as HTMLElement;
        const cleanup = ui.attachListeners();

        const table = prose.querySelector("table");
        expect(table).toBeTruthy();
        table!.getBoundingClientRect = () => fakeRect(100, 200, 300, 100);

        // The activation goes through the selection (a click), not hover.
        editor.commands.setTextSelection(3);
        ui.syncSelection(editor);

        expect(ui.activeRect).not.toBeNull();
        // A north placement: `top` is the table's upper edge in content coordinates (200 + offTop 50);
        // the toolbar lifts itself with translateY(-100% - gap) inside the component.
        expect(ui.toolbarPlacement).toBe("north");
        expect(ui.toolbarPos.top).toBe(250);

        cleanup();
    });

    it("showControls stays open while the table menu is open", () => {
        const editor = makeTableEditor();
        editors.push(editor);
        const menus = new PopoverMenus();
        const ui = new TableUiController(
            menus,
            () => editor,
            () => undefined,
        );
        expect(ui.showControls).toBe(false);
        menus.toggle("table");
        expect(ui.showControls).toBe(true);
        menus.toggle("tableRow");
        expect(ui.showControls).toBe(true);
        menus.closeAll();
        expect(ui.showControls).toBe(false);

        ui.isHoveringControls = true;
        expect(ui.showControls).toBe(true);
    });

    it("ensureCellSelection promotes a caret into a single-cell CellSelection", () => {
        const editor = makeTableEditor(`
          <table>
            <tr><th>a</th><th>b</th></tr>
            <tr><td>1</td><td>2</td></tr>
          </table>`);
        editors.push(editor);
        editor.commands.setTextSelection(6);
        expect(editor.state.selection).not.toBeInstanceOf(CellSelection);

        expect(ensureCellSelection(editor)).toBe(true);
        const sel = editor.state.selection as CellSelection;
        expect(sel).toBeInstanceOf(CellSelection);
        expect(sel.isColSelection()).toBe(false);
        expect(sel.isRowSelection()).toBe(false);
    });

    it("ensureCellSelection does nothing outside a table", () => {
        const editor = makeTableEditor("<p>plain</p>");
        editors.push(editor);
        expect(ensureCellSelection(editor)).toBe(false);
    });

    // ── preservetable columns + row heights ───────────────────────────────────────────────

    /** Mounts the controller over a table and stubs the geometry (jsdom has no layout). */
    function mountWithGeometry(
        editor: Editor,
        opts: { colWidths: number[]; rowHeights: number[]; wrapperWidth?: number },
    ): { ui: TableUiController; cleanup: () => void } {
        const menus = new PopoverMenus();
        const ui = new TableUiController(
            menus,
            () => editor,
            () => undefined,
        );
        const prose = editor.view.dom as HTMLElement;
        const cleanup = ui.attachListeners();
        const table = prose.querySelector("table") as HTMLTableElement;
        const totalW = opts.colWidths.reduce((a, b) => a + b, 0);
        const totalH = opts.rowHeights.reduce((a, b) => a + b, 0);
        table.getBoundingClientRect = () => fakeRect(100, 200, totalW, totalH);
        // jsdom has no layout: `clientWidth` is 0 and the fitting is skipped. A test that needs it sets
        // the wrapper's width explicitly.
        if (opts.wrapperWidth !== undefined) {
            const wrapper = prose.querySelector(".tableWrapper") as HTMLElement;
            Object.defineProperty(wrapper, "clientWidth", {
                value: opts.wrapperWidth,
                configurable: true,
            });
        }

        Array.from(table.rows).forEach((row, r) => {
            const top = 200 + opts.rowHeights.slice(0, r).reduce((a, b) => a + b, 0);
            row.getBoundingClientRect = () => fakeRect(100, top, totalW, opts.rowHeights[r] ?? 0);
            Array.from(row.cells).forEach((cell, c) => {
                const left = 100 + opts.colWidths.slice(0, c).reduce((a, b) => a + b, 0);
                cell.getBoundingClientRect = () =>
                    fakeRect(left, top, opts.colWidths[c] ?? 0, opts.rowHeights[r] ?? 0);
            });
        });

        editor.commands.setTextSelection(3);
        ui.syncSelection(editor);
        return { ui, cleanup };
    }

    function mouse(type: string, x: number, y: number): MouseEvent {
        return new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    }

    /** The first row's `colwidth`, in column order. */
    function colWidths(editor: Editor): (number | undefined)[] {
        const table = editor.state.doc.firstChild;
        const row = table?.firstChild;
        const out: (number | undefined)[] = [];
        row?.forEach((cell) => {
            const cw = cell.attrs.colwidth as number[] | null;
            out.push(...(cw ?? [undefined]));
        });
        return out;
    }

    it("resizing a column boundary changes only the two neighbouring columns and preserves the sum", () => {
        const editor = makeTableEditor(
            `<table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td><td>f</td></tr></table>`,
        );
        editors.push(editor);
        const { ui, cleanup } = mountWithGeometry(editor, {
            colWidths: [100, 100, 100],
            rowHeights: [50, 50],
        });

        ui.onColumnBoundaryMouseDown(0, mouse("mousedown", 200, 220));
        window.dispatchEvent(mouse("mousemove", 230, 220));
        window.dispatchEvent(mouse("mouseup", 230, 220));

        // Columns 0 and 1 only; the sum is unchanged; every column has a colwidth.
        expect(colWidths(editor)).toEqual([130, 70, 100]);
        cleanup();
    });

    it("the sum of the colwidths fits the wrapper (no cut-off right edge)", () => {
        const editor = makeTableEditor(`<table><tr><td>a</td><td>b</td><td>c</td></tr></table>`);
        editors.push(editor);
        const { ui, cleanup } = mountWithGeometry(editor, {
            colWidths: [100, 100, 100],
            rowHeights: [50],
            wrapperWidth: 300,
        });

        ui.onColumnBoundaryMouseDown(0, mouse("mousedown", 200, 220));
        window.dispatchEvent(mouse("mousemove", 230, 220));
        window.dispatchEvent(mouse("mouseup", 230, 220));

        const widths = colWidths(editor) as number[];
        const sum = widths.reduce((a, b) => a + b, 0);
        // `TableView` writes `table { min-width: <sum> }`; the sum has to stay BELOW the wrapper's
        // width (the table's collapsed border adds ~1 px), or the table sticks out and the edge is cut
        // off.
        expect(sum).toBeLessThan(300);
        // The gesture still changes only two neighbouring columns.
        expect(widths[2]).toBe(100);
        cleanup();
    });

    it("a column is not squeezed below cellMinWidth", () => {
        const editor = makeTableEditor(`<table><tr><td>a</td><td>b</td></tr></table>`);
        editors.push(editor);
        const { ui, cleanup } = mountWithGeometry(editor, {
            colWidths: [100, 100],
            rowHeights: [50],
        });

        ui.onColumnBoundaryMouseDown(0, mouse("mousedown", 200, 220));
        window.dispatchEvent(mouse("mousemove", 500, 220));
        window.dispatchEvent(mouse("mouseup", 500, 220));

        expect(colWidths(editor)).toEqual([175, 25]);
        cleanup();
    });

    it("resizing a row boundary sets that row's height", () => {
        const editor = makeTableEditor(`<table><tr><td>a</td></tr><tr><td>b</td></tr></table>`);
        editors.push(editor);
        const { ui, cleanup } = mountWithGeometry(editor, {
            colWidths: [200],
            rowHeights: [50, 50],
        });

        ui.onRowBoundaryMouseDown(0, mouse("mousedown", 150, 250));
        window.dispatchEvent(mouse("mousemove", 150, 275));
        window.dispatchEvent(mouse("mouseup", 150, 275));

        const table = editor.state.doc.firstChild;
        expect(table?.child(0).attrs.style).toBe("height: 75px");
        expect(table?.child(1).attrs.style).toBe("height: 50px");
        cleanup();
    });
});
