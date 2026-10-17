import type { Editor } from "@tiptap/core";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";

import { tableWidthStyle } from "./extensions/table";
import { rowHeightStyle } from "./extensions/table-row";
import { isTableMenuOpen, type PopoverMenus } from "./PopoverMenus.svelte";

/**
 * The gap in px between the toolbar and the table's edge. One source of truth —
 * `TableToolbar.svelte` uses it in `translateY` for the north placement.
 */
export const TABLE_TOOLBAR_GAP = 4;

/**
 * An estimate of the toolbar's height. It serves ONLY the north/south decision; in a north
 * placement the toolbar lifts itself with `translateY(-100%)`, so its real height (which changes
 * with the UI zoom, because the buttons are sized in rem) need not enter the arithmetic.
 */
const TOOLBAR_H_EST = 32;

/** The `cellMinWidth` from `@tiptap/extension-table` — a column must not be squeezed below it. */
const MIN_COL_W = 25;
/** The smallest row height (px). Below it a row visually collapses onto its padding. */
const MIN_ROW_H = 24;

/**
 * The slack in px that `<table>` adds on top of the sum of the column widths (the collapsed border),
 * plus protection against percentage rounding. Without it the table's `min-width` exceeds the wrapper
 * and the right edge is cut off.
 */
const BORDER_SLACK = 2;

/** One column's / one row's segment, in viewport coordinates. */
type Seg = { start: number; size: number };

/** A table corner; `e`/`w` gives the width direction, `s`/`n` the height direction. */
export type Corner = "nw" | "ne" | "sw" | "se";

export class TableUiController {
    activeRect = $state<DOMRect | null>(null);
    toolbarPos = $state({ top: 0, left: 0 });
    toolbarPlacement = $state<"north" | "south">("north");
    edgePos = $state({ leftStart: 0, rightStart: 0, top: 0, height: 0 });

    /** The table's box in scroll-content coordinates — the anchor for the boundaries and the corners. */
    gridPos = $state({ left: 0, top: 0, width: 0, height: 0 });
    /** The x of the inner column boundaries (content coordinates); the index is the column left of the boundary. */
    colBounds = $state<number[]>([]);
    /** The y of the inner row boundaries (content coordinates); the index = the row above the boundary. */
    rowBounds = $state<number[]>([]);

    /**
     * The guide that follows the cursor during a boundary resize (HugeRTE's `BarManager` moves the
     * bar on the `drag` event). Without it nothing is visible during the gesture: the strip stays in
     * its old position and the hover indicator goes out as soon as the cursor leaves it.
     */
    dragGuide = $state<{ axis: "col" | "row"; pos: number } | null>(null);

    /**
     * The outline of the table's future size during a corner drag (in content coordinates).
     *
     * The corner handle sits at `gridPos`, and `gridPos` is deliberately not refreshed during the drag
     * (`revalidateActive` and the scroll both bail out early on `isResizing`) — without an outline the
     * gesture looks dead: the handle stays at the old corner, and the table only moves on `mouseup`.
     */
    dragOutline = $state<{ left: number; top: number; width: number; height: number } | null>(null);

    isHoveringControls = $state(false);
    isDragging = $state(false);
    isResizing = $state(false);

    get showControls(): boolean {
        if (typeof window !== "undefined" && !window.matchMedia("(any-pointer: fine)").matches)
            return false;
        // The dialog is modal; the floating controls live in a scroll container with its own stacking
        // context, so otherwise they would keep drawing over it regardless of z-index.
        if (this.propertiesOpen) return false;

        return (
            this.activeRect !== null ||
            this.isHoveringControls ||
            this.isDragging ||
            this.isResizing ||
            isTableMenuOpen(this.menus)
        );
    }

    #activeTableEl: HTMLElement | null = null;
    #cancelResizeDrag: (() => void) | null = null;
    /** The table rect for which `colBounds` and `rowBounds` were last computed. */
    #gridKey = "";

    get editor(): Editor | undefined {
        return this.getEditor();
    }

    constructor(
        private menus: PopoverMenus,
        private getEditor: () => Editor | undefined,
        private getScrollEl: () => HTMLElement | undefined,
    ) {}

    #applyTableRect(r: DOMRect): void {
        this.activeRect = r;
        const sc = this.getScrollEl();
        const scRect = sc?.getBoundingClientRect();
        const offTop = sc && scRect ? sc.scrollTop - scRect.top : 0;
        const offLeft = sc && scRect ? sc.scrollLeft - scRect.left : 0;

        const topSpace = scRect ? r.top - scRect.top : r.top;

        // North: `top` is the table's upper edge, and the toolbar lifts itself by its own height plus
        // the gap (a transform in the component). South: `top` is already below the table, so no
        // transform is needed.
        if (topSpace >= TOOLBAR_H_EST + TABLE_TOOLBAR_GAP) {
            this.toolbarPlacement = "north";
            this.toolbarPos = { top: r.top + offTop, left: r.left + offLeft };
        } else {
            this.toolbarPlacement = "south";
            this.toolbarPos = {
                top: r.bottom + offTop + TABLE_TOOLBAR_GAP,
                left: r.left + offLeft,
            };
        }

        this.edgePos = {
            leftStart: r.left + offLeft - 10,
            rightStart: r.right + offLeft + 2,
            top: r.top + offTop,
            height: r.height,
        };

        this.gridPos = {
            left: r.left + offLeft,
            top: r.top + offTop,
            width: r.width,
            height: r.height,
        };

        // The boundaries are the segments' cumulative edges, the outer ones excluded (the edge bars cover those).
        // The segments need a `getBoundingClientRect` per cell and row, while `#applyTableRect` is
        // called on EVERY mousemove over the table — so they are computed only when the table's rect
        // actually changes (a resize, a row/column added, a scroll that changes the geometry).
        const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
        if (key !== this.#gridKey) {
            this.#gridKey = key;
            const cols = this.#columnSegments();
            const rows = this.#rowSegments();
            this.colBounds = cols.slice(0, -1).map((s) => s.start + s.size + offLeft);
            this.rowBounds = rows.slice(0, -1).map((s) => s.start + s.size + offTop);
        }
    }

    /**
     * The column widths in viewport coordinates.
     *
     * It measures a **row without any `colspan`** — only such a row gives exact per-column pixel
     * widths. If there is none (every row has a merged cell), it returns empty and no column
     * boundaries are drawn: better no handle at all than a handle that would commit wrong
     * `colwidth`s.
     */
    #columnSegments(): Seg[] {
        const tableEl = this.#activeTableEl as HTMLTableElement | null;
        if (!tableEl?.isConnected) return [];
        const row = Array.from(tableEl.rows).find((r) =>
            Array.from(r.cells).every((c) => c.colSpan === 1),
        );
        if (!row) return [];
        return Array.from(row.cells).map((c) => {
            const r = c.getBoundingClientRect();
            return { start: r.left, size: r.width };
        });
    }

    /** The row heights in viewport coordinates — a `<tr>` has its own box, so this comes straight out of the DOM. */
    #rowSegments(): Seg[] {
        const tableEl = this.#activeTableEl as HTMLTableElement | null;
        if (!tableEl?.isConnected) return [];
        return Array.from(tableEl.rows).map((r) => {
            const rect = r.getBoundingClientRect();
            return { start: rect.top, size: rect.height };
        });
    }

    attachListeners(): () => void {
        // The controls are activated by the SELECTION (a click into the table), not by hover — see
        // `syncSelection`. All that remains here is tracking the scroll, so the rect stays accurate
        // while the table is active.
        const onScroll = () => {
            if (this.activeRect === null || this.isDragging || this.isResizing) return;
            const el = this.#activeTableEl;
            if (!el?.isConnected) {
                this.activeRect = null;
                return;
            }
            this.#applyTableRect(el.getBoundingClientRect());
        };

        window.addEventListener("scroll", onScroll, { capture: true, passive: true });

        return () => {
            window.removeEventListener("scroll", onScroll, { capture: true });
            this.#cancelResizeDrag?.();
        };
    }

    /** The doc changed: the geometry is stale, and the table may even have been deleted. */
    revalidateActive(): void {
        if (this.activeRect === null || this.isDragging || this.isResizing) return;
        if (!this.#resolveTable()) {
            this.activeRect = null;
            this.isHoveringControls = false;
        } else {
            const el = this.#activeTableEl;
            if (el?.isConnected) {
                // The table's rect does NOT change during a `preservetable` resize (the sum of the
                // widths is constant), so the boundary cache has to be dropped explicitly — otherwise
                // the handle stays where the boundary used to be.
                this.#gridKey = "";
                this.#applyTableRect(el.getBoundingClientRect());
            }
        }
    }

    /**
     * The only entry point that activates the controls: the caret (or a CellSelection) is inside the
     * table.
     *
     * It is called from `onTransaction`, so on a click and on the keyboard alike. Hover deliberately
     * activates **nothing** — otherwise the bars and the toolbar pop up while the user merely moves the
     * mouse across the document.
     */
    syncSelection(editor: Editor): void {
        if (isTableMenuOpen(this.menus) || this.isResizing || this.isDragging) return;

        try {
            const { selection } = editor.state;
            let tablePos: number | null = null;
            let d = selection.$from.depth;
            while (d > 0) {
                if (selection.$from.node(d).type.name === "table") {
                    tablePos = selection.$from.before(d);
                    break;
                }
                d--;
            }

            if (tablePos === null) {
                // The mouse on the controls keeps the table active. Without this, a mousedown on the
                // grip (which dispatches a transaction before `dragstart`) unmounts TableControls, the
                // browser never starts the drag, and the table cannot be moved.
                if (!this.isHoveringControls) {
                    this.activeRect = null;
                    this.#activeTableEl = null;
                }
                return;
            }

            const wrapper = editor.view.nodeDOM(tablePos) as HTMLElement | null;
            if (wrapper) {
                const tableEl =
                    wrapper.tagName === "TABLE" ? wrapper : wrapper.querySelector("table");
                if (tableEl?.isConnected) {
                    if (tableEl !== this.#activeTableEl) this.#gridKey = "";
                    this.#activeTableEl = tableEl;
                    this.#applyTableRect(tableEl.getBoundingClientRect());
                }
            }
        } catch (_) {}
    }

    #resolveTable(): { pos: number; wrapperEl: HTMLElement } | null {
        const editor = this.getEditor();
        if (!this.activeRect || !editor) return null;
        const proseDom = editor.view.dom as HTMLElement;
        const tableEl = this.#activeTableEl;
        if (!tableEl?.isConnected) return null;
        const wrapperEl = (tableEl.closest(".tableWrapper") ?? tableEl) as HTMLElement;
        if (!proseDom.contains(wrapperEl)) return null;
        let pos = -1;
        try {
            pos = editor.view.posAtDOM(wrapperEl, 0) - 1;
        } catch (_) {
            return null;
        }
        const node = editor.view.state.doc.nodeAt(pos);
        if (node?.type.name !== "table") return null;
        return { pos, wrapperEl };
    }

    selectTable(): void {
        const editor = this.getEditor();
        const t = this.#resolveTable();
        if (!editor || !t) return;
        editor.chain().focus(undefined, { scrollIntoView: false }).setNodeSelection(t.pos).run();
    }

    selectRowAtCaret(): void {
        const editor = this.getEditor();
        if (!editor) return;
        const { selection } = editor.state;
        let cellPos = -1;
        let d = selection.$from.depth;
        while (d > 0) {
            const name = selection.$from.node(d).type.name;
            if (name === "tableCell" || name === "tableHeader") {
                cellPos = selection.$from.before(d);
                break;
            }
            d--;
        }
        if (cellPos >= 0) {
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    CellSelection.rowSelection(editor.state.doc.resolve(cellPos)),
                ),
            );
        }
    }

    selectColumnAtCaret(): void {
        const editor = this.getEditor();
        if (!editor) return;
        const { selection } = editor.state;
        let cellPos = -1;
        let d = selection.$from.depth;
        while (d > 0) {
            const name = selection.$from.node(d).type.name;
            if (name === "tableCell" || name === "tableHeader") {
                cellPos = selection.$from.before(d);
                break;
            }
            d--;
        }
        if (cellPos >= 0) {
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    CellSelection.colSelection(editor.state.doc.resolve(cellPos)),
                ),
            );
        }
    }

    /** The Table properties dialog is open. The menu only flips this to `true`. */
    propertiesOpen = $state(false);

    /** The active table's attributes — the dialog reads them to prefill its fields. */
    activeTableAttrs(): Record<string, unknown> | null {
        const editor = this.getEditor();
        const t = this.#resolveTable();
        if (!editor || !t) return null;
        const node = editor.state.doc.nodeAt(t.pos);
        return node?.type.name === "table" ? node.attrs : null;
    }

    /** One Apply = one transaction = one undo step. */
    setTableProps(props: Record<string, unknown>): void {
        const editor = this.getEditor();
        const t = this.#resolveTable();
        if (!editor || !t) return;
        const { state } = editor.view;
        const node = state.doc.nodeAt(t.pos);
        if (node?.type.name !== "table") return;
        editor.view.dispatch(state.tr.setNodeMarkup(t.pos, undefined, { ...node.attrs, ...props }));
    }

    resetWidth(): void {
        const editor = this.getEditor();
        const t = this.#resolveTable();
        if (!editor || !t) return;
        const { state } = editor.view;
        const node = state.doc.nodeAt(t.pos);
        if (node?.type.name === "table") {
            editor.view.dispatch(
                state.tr.setNodeMarkup(t.pos, undefined, { ...node.attrs, style: null }),
            );
        }
    }

    onDragStart(e: DragEvent): void {
        const editor = this.getEditor();
        const t = this.#resolveTable();
        if (!editor || !t || !e.dataTransfer) {
            e.preventDefault();
            return;
        }
        // The flag goes BEFORE the focus: `focus()` dispatches a transaction, and `syncSelection` on
        // that transaction clears activeRect when the caret is not inside the table (the mouse is on
        // the toolbar, not in it). That unmounts TableControls mid-dragstart and the browser cancels
        // the drag — the table does not move. `isDragging` guards both syncSelection and
        // revalidateActive.
        this.isDragging = true;
        editor.chain().focus(undefined, { scrollIntoView: false }).run();
        const tableSel = NodeSelection.create(editor.state.doc, t.pos);
        editor.view.dragging = {
            slice: tableSel.content(),
            move: true,
            node: tableSel,
        } as typeof editor.view.dragging;

        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/html", t.wrapperEl.innerHTML);
        e.dataTransfer.setDragImage(t.wrapperEl, 12, 12);
    }

    onDragEnd(): void {
        this.isDragging = false;
        const editor = this.getEditor();
        if (editor) editor.view.dragging = null;
        // `activeRect`/`gridPos`/toolbarPos are frozen from BEFORE the gesture (deliberately — they
        // are not refreshed during a drag). The mouse hovering over the (invisible but still mounted)
        // wrapper during the drag keeps `isHoveringControls` true, so the old code skipped
        // the null-out and the controls reappeared at EXACTLY the old position — until the user
        // clicked the table, which calls syncSelection again. Instead of an ad-hoc null check, the
        // resync goes through `syncSelection`: it already knows how to derive the active table from
        // the current selection (which ProseMirror's drop handler leaves on the moved node) and
        // compute a FRESH rect, or to null out correctly when the selection is no longer in a table.
        if (editor) {
            this.#activeTableEl = null;
            this.#gridKey = "";
            this.syncSelection(editor);
        }
    }

    onEdgeMouseDown(side: "left" | "right", e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const editor = this.getEditor();
        if (!this.activeRect || !editor) return;

        const proseDom = editor.view.dom as HTMLElement;
        const containerW = proseDom.getBoundingClientRect().width;
        if (!containerW) return;

        const startX = e.clientX;
        const resolved = this.#resolveTable();
        if (!resolved) return;
        const { pos: tableNodePos, wrapperEl } = resolved;

        const wrapperStartW = wrapperEl.getBoundingClientRect().width;
        const startCols = this.#pinnedColWidths();
        let finalPct = Math.round((wrapperStartW / containerW) * 100);
        let cols = startCols;

        this.#startDrag(
            (mv) => {
                const dx = mv.clientX - startX;
                // The table is anchored on the left, so the movement is 1:1 (it used to be
                // 2·dx because of the centring). The right edge follows the cursor; the left edge
                // shortens from the other side.
                const k = side === "right" ? +1 : -1;
                const newW = Math.max(
                    containerW * 0.2,
                    Math.min(wrapperStartW + k * dx, containerW),
                );
                finalPct = Math.max(20, Math.min(100, Math.round((newW / containerW) * 100)));
                wrapperEl.style.width = finalPct >= 99 ? "" : `${finalPct}%`;
                // The columns are scaled to the ROUNDED width, not to the raw delta — otherwise the
                // sum exceeds the wrapper and the table gets a scrollbar instead of fitting.
                cols = this.#fitColsToWidth(startCols, this.#widthForPct(finalPct, containerW));
            },
            () => {
                if (editor.isDestroyed) return;
                const style = finalPct >= 99 ? null : tableWidthStyle(`${finalPct}%`);
                const { state } = editor.view;
                const node = state.doc.nodeAt(tableNodePos);
                if (node?.type.name !== "table") return;
                const tr = state.tr.setNodeMarkup(tableNodePos, undefined, {
                    ...node.attrs,
                    style,
                });
                this.#addColWidthsToTr(tr, tableNodePos, cols);
                editor.view.dispatch(tr);
            },
        );
    }

    /**
     * The columns' current pixel widths — **only if they are already fixed** (a `colwidth` exists).
     *
     * While the columns have no `colwidth`, the table is fluid and follows the wrapper's width by
     * itself; a width resize must then fix nothing. As soon as they are fixed, changing the table's
     * width has to scale them proportionally — otherwise `min-width` (their sum) holds the table and
     * the wrapper merely gains a scrollbar.
     */
    #pinnedColWidths(): number[] {
        const editor = this.getEditor();
        const t = this.#resolveTable();
        const table = editor && t ? editor.state.doc.nodeAt(t.pos) : null;
        const row = table?.firstChild;
        if (!row) return [];
        let anyFixed = false;
        row.forEach((cell) => {
            if ((cell.attrs.colwidth as number[] | null)?.some((w) => w > 0)) anyFixed = true;
        });
        return anyFixed ? this.#columnSegments().map((s) => s.size) : [];
    }

    /**
     * Scales the column widths so their sum **fits the given table width**, and immediately
     * Scales the column widths so their sum **fits the given table width**, and draws them into
     * the `<col>` elements right away.
     * Why a target width rather than a bare factor: `TableView` writes `table { min-width: <sum> }`,
     * so if the sum exceeds the wrapper's width (the percentage is rounded to a whole number, plus
     * per-column rounding) the table sticks out of the wrapper — the right edge is cut off and a
     * horizontal scrollbar appears. The rounding is therefore collected into the last column, and
     * `BORDER_SLACK` covers the collapsed border that `<table>` adds on top of the columns' sum.
     */
    #fitColsToWidth(startCols: number[], targetW: number): number[] {
        if (!startCols.length) return startCols;
        const startSum = startCols.reduce((a, b) => a + b, 0);
        if (!startSum) return startCols;
        // With no layout (a hidden editor, jsdom) there is nothing to fit into — keep what was measured.
        if (!Number.isFinite(targetW) || targetW <= 0) return startCols;

        const target = Math.max(MIN_COL_W * startCols.length, Math.floor(targetW) - BORDER_SLACK);
        const next = startCols.map((w) => Math.max(MIN_COL_W, Math.round((w * target) / startSum)));
        const drift = target - next.reduce((a, b) => a + b, 0);
        const last = next.length - 1;
        const lastW = next[last];
        if (lastW !== undefined) next[last] = Math.max(MIN_COL_W, lastW + drift);

        const colgroup = this.#activeTableEl?.querySelector("colgroup");
        if (colgroup) {
            for (let i = 0; i < next.length; i++) {
                const col = colgroup.children[i] as HTMLElement | undefined;
                const w = next[i];
                if (col && w !== undefined) col.style.width = `${w}px`;
            }
        }
        return next;
    }

    /** The table's pixel width for a given percentage; `>= 99 %` means the container's full width. */
    #widthForPct(pct: number, containerW: number): number {
        return pct >= 99 ? containerW : (containerW * pct) / 100;
    }

    /** The shared frame for every resize gesture: window listeners, teardown and `isResizing`. */
    #startDrag(onMove: (e: MouseEvent) => void, onCommit: () => void): void {
        const move = (e: MouseEvent) => onMove(e);
        const detach = () => {
            this.isResizing = false;
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            this.#cancelResizeDrag = null;
        };
        const up = () => {
            detach();
            onCommit();
        };
        this.isResizing = true;
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        this.#cancelResizeDrag = detach;
    }

    /**
     * Resizing the boundary between columns `index` and `index + 1` — HugeRTE `preservetable`.
     *
     * The sum of the widths stays constant, so the other columns do not move by a single pixel. The
     * preview goes straight into the `<col>` elements (TableView rewrites them on every update
     * anyway), and one `mouseup` commits every `colwidth` in a single transaction → one undo step.
     */
    onColumnBoundaryMouseDown(index: number, e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const editor = this.getEditor();
        const resolved = this.#resolveTable();
        const tableEl = this.#activeTableEl as HTMLTableElement | null;
        const colgroup = tableEl?.querySelector("colgroup");
        if (!editor || !colgroup || !resolved) return;

        // Seed EVERY column from the measured widths — the sum then matches the table's rendered
        // width, the scaling factor is 1 and the boundary follows the cursor 1:1. The seed goes through
        // `#fitColsToWidth`, so the sum fits the wrapper: otherwise the table's `min-width` comes out
        // larger than the wrapper by the collapsed border and the right edge is cut off.
        const widths = this.#fitColsToWidth(
            this.#columnSegments().map((s) => s.size),
            resolved.wrapperEl.clientWidth,
        );
        const w0 = widths[index];
        const w1 = widths[index + 1];
        if (w0 === undefined || w1 === undefined) return;

        const startX = e.clientX;
        let next = widths.slice();

        const startBound = this.colBounds[index] ?? 0;

        this.#startDrag(
            (mv) => {
                const raw = mv.clientX - startX;
                const dx = Math.max(MIN_COL_W - w0, Math.min(raw, w1 - MIN_COL_W));
                next = widths.slice();
                next[index] = w0 + dx;
                next[index + 1] = w1 - dx;
                for (let i = 0; i < next.length; i++) {
                    const col = colgroup.children[i] as HTMLElement | undefined;
                    const w = next[i];
                    if (col && w !== undefined) col.style.width = `${Math.round(w)}px`;
                }
                this.dragGuide = { axis: "col", pos: startBound + dx };
            },
            () => {
                this.dragGuide = null;
                if (!editor.isDestroyed) this.#commitColumnWidths(next);
            },
        );
    }

    /** Writes `colwidth` for every column in one transaction (honouring colspan and rowspan). */
    #commitColumnWidths(widths: number[]): void {
        const editor = this.getEditor();
        const t = this.#resolveTable();
        if (!editor || !t) return;
        const tr = editor.view.state.tr;
        this.#addColWidthsToTr(tr, t.pos, widths);
        if (tr.docChanged) editor.view.dispatch(tr);
    }

    /** The `colwidth` steps into an existing transaction — shared by the column, boundary and corner resizes. */
    #addColWidthsToTr(tr: Transaction, tablePos: number, widths: number[]): void {
        const editor = this.getEditor();
        if (!editor || !widths.length) return;
        const table = editor.view.state.doc.nodeAt(tablePos);
        if (table?.type.name !== "table") return;

        let map: TableMap;
        try {
            map = TableMap.get(table);
        } catch (_) {
            return;
        }

        // A cell's relative position → its new `colwidth` array. A cell with a `colspan` is filled
        // over several passes, which is why this accumulates instead of dispatching per column.
        const pending = new Map<number, number[]>();
        for (let col = 0; col < map.width; col++) {
            const width = widths[col];
            if (width === undefined) continue;
            for (let row = 0; row < map.height; row++) {
                const idx = row * map.width + col;
                const rel = map.map[idx];
                if (rel === undefined) continue;
                // Rowspan: the same cell appears in several rows — handle it once.
                if (row > 0 && map.map[idx - map.width] === rel) continue;
                const cell = table.nodeAt(rel);
                if (!cell) continue;
                const colspan = (cell.attrs.colspan as number) ?? 1;
                const current =
                    pending.get(rel) ??
                    (cell.attrs.colwidth as number[] | null)?.slice() ??
                    new Array<number>(colspan).fill(0);
                const offset = colspan === 1 ? 0 : col - map.colCount(rel);
                if (offset >= 0 && offset < current.length) current[offset] = Math.round(width);
                pending.set(rel, current);
            }
        }

        for (const [rel, colwidth] of pending) {
            const cell = table.nodeAt(rel);
            if (!cell) continue;
            tr.setNodeMarkup(tablePos + 1 + rel, undefined, { ...cell.attrs, colwidth });
        }
    }

    /**
     * Resizing the boundary between rows `index` and `index + 1` — it changes **only** the upper row's
     * height, and the table grows by the same difference (the `Adjustments.adjustHeight` model from
     * HugeRTE).
     */
    onRowBoundaryMouseDown(index: number, e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const editor = this.getEditor();
        const tableEl = this.#activeTableEl as HTMLTableElement | null;
        const rowEl = tableEl?.rows[index] as HTMLElement | undefined;
        const h0 = this.#rowSegments()[index]?.size;
        if (!editor || !rowEl || h0 === undefined) return;

        const startY = e.clientY;
        const startBound = this.rowBounds[index] ?? 0;
        let height = h0;

        this.#startDrag(
            (mv) => {
                height = Math.max(MIN_ROW_H, h0 + (mv.clientY - startY));
                rowEl.style.height = `${Math.round(height)}px`;
                this.dragGuide = { axis: "row", pos: startBound + (height - h0) };
            },
            () => {
                this.dragGuide = null;
                if (editor.isDestroyed) return;
                const heights = this.#rowSegments().map((s) => s.size);
                heights[index] = height;
                this.#commitRowHeights(heights);
            },
        );
    }

    /** Writes every row's height in one transaction. */
    #commitRowHeights(heights: number[]): void {
        const editor = this.getEditor();
        const t = this.#resolveTable();
        if (!editor || !t) return;
        const { state } = editor.view;
        const table = state.doc.nodeAt(t.pos);
        if (table?.type.name !== "table") return;

        const tr = state.tr;
        table.forEach((row, offset, i) => {
            const h = heights[i];
            if (h === undefined) return;
            const style = rowHeightStyle(`${Math.round(h)}px`);
            if ((row.attrs.style ?? null) === style) return;
            tr.setNodeMarkup(t.pos + 1 + offset, undefined, { ...row.attrs, style });
        });
        if (tr.docChanged) editor.view.dispatch(tr);
    }

    /**
     * The corner handle: width and height in one gesture.
     *
     * Horizontally it changes the table's percentage width; vertically it spreads the delta across the
     * rows proportionally (the table's height is the sum of its rows' heights). The commit is one
     * transaction over the table and every row → one undo step.
     */
    onCornerMouseDown(corner: Corner, e: MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const editor = this.getEditor();
        const resolved = this.#resolveTable();
        const tableEl = this.#activeTableEl as HTMLTableElement | null;
        if (!editor || !resolved || !tableEl) return;

        const proseDom = editor.view.dom as HTMLElement;
        const containerW = proseDom.getBoundingClientRect().width;
        const rows = this.#rowSegments();
        const startHeights = rows.map((s) => s.size);
        const totalH = startHeights.reduce((a, b) => a + b, 0);
        if (!containerW || !totalH) return;

        const { pos: tableNodePos, wrapperEl } = resolved;
        const wrapperStartW = wrapperEl.getBoundingClientRect().width;
        const startCols = this.#pinnedColWidths();
        const kx = corner === "ne" || corner === "se" ? 1 : -1;
        const ky = corner === "se" || corner === "sw" ? 1 : -1;

        const startX = e.clientX;
        const startY = e.clientY;
        let finalPct = Math.round((wrapperStartW / containerW) * 100);
        let heights = startHeights.slice();
        let cols = startCols;

        this.#startDrag(
            (mv) => {
                const newW = Math.max(
                    containerW * 0.2,
                    Math.min(wrapperStartW + kx * (mv.clientX - startX), containerW),
                );
                finalPct = Math.max(20, Math.min(100, Math.round((newW / containerW) * 100)));
                wrapperEl.style.width = finalPct >= 99 ? "" : `${finalPct}%`;
                cols = this.#fitColsToWidth(startCols, this.#widthForPct(finalPct, containerW));

                const scale = Math.max(
                    MIN_ROW_H * rows.length,
                    totalH + ky * (mv.clientY - startY),
                );
                const factor = scale / totalH;
                heights = startHeights.map((h) => Math.max(MIN_ROW_H, h * factor));
                for (let i = 0; i < heights.length; i++) {
                    const rowEl = tableEl.rows[i] as HTMLElement | undefined;
                    const h = heights[i];
                    if (rowEl && h !== undefined) rowEl.style.height = `${Math.round(h)}px`;
                }

                // The outline follows the cursor even when the table itself cannot (it is already at
                // full width, say, or the columns' `min-width` holds the lower bound).
                const newH = heights.reduce((a, b) => a + b, 0);
                this.dragOutline = {
                    left: this.gridPos.left,
                    top: this.gridPos.top,
                    width: newW,
                    height: newH,
                };
            },
            () => {
                this.dragOutline = null;
                if (editor.isDestroyed) return;
                const { state } = editor.view;
                const table = state.doc.nodeAt(tableNodePos);
                if (table?.type.name !== "table") return;
                const tr = state.tr;
                const style = finalPct >= 99 ? null : tableWidthStyle(`${finalPct}%`);
                tr.setNodeMarkup(tableNodePos, undefined, { ...table.attrs, style });
                this.#addColWidthsToTr(tr, tableNodePos, cols);
                table.forEach((row, offset, i) => {
                    const h = heights[i];
                    if (h === undefined) return;
                    tr.setNodeMarkup(tableNodePos + 1 + offset, undefined, {
                        ...row.attrs,
                        style: rowHeightStyle(`${Math.round(h)}px`),
                    });
                });
                if (tr.docChanged) editor.view.dispatch(tr);
            },
        );
    }
}
