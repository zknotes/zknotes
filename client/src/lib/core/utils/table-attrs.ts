/**
 * Presentation carried as validated `data-*` attributes — the one place of truth for reading it
 * back into inline style on already-sanitised DOM.
 *
 * `sanitizeHtml` and `sanitizeShareHtml` both strip `style` (a `url()` tracking pixel, a
 * `position:fixed` overlay over a button). The editor therefore stores every user-chosen dimension
 * and table property twice: once as inline `style` for the live ProseMirror view, and once as a
 * validated `data-*` / `width` attribute that survives sanitisation. Every render that goes through
 * a sanitiser — the share page (`/s/:id`), the HTML export, the conflict inbox — reconstructs the
 * style from the attribute with the functions below.
 *
 * Lives in `core/utils` because both `modules/editor` (which writes the attributes) and
 * `modules/export` (which reads them) need it, and a module may not import another module.
 */

/** The percentage width the user dragged with the resize bar — the only accepted form. */
export const TABLE_WIDTH_PCT = /^\d{1,3}(?:\.\d+)?%$/;
/** The row height the user dragged — a whole number of pixels. */
export const ROW_HEIGHT_PX = /^\d{1,4}px$/;
/** An image's display width: `640px` or `50%`. */
export const IMAGE_WIDTH = /^\d{1,5}(?:px|%)$/;

export const TABLE_BORDER_STYLES = ["none", "solid", "dashed", "dotted", "double"] as const;
export type TableBorderStyle = (typeof TABLE_BORDER_STYLES)[number];

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A whole number of pixels within [0, max]; anything else → `null`. */
export function pxInRange(value: unknown, max: number): number | null {
    const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

export function tableBorderStyle(value: unknown): TableBorderStyle | null {
    const s = String(value ?? "");
    return (TABLE_BORDER_STYLES as readonly string[]).includes(s) ? (s as TableBorderStyle) : null;
}

export function tableColor(value: unknown): string | null {
    const s = String(value ?? "").trim();
    return COLOR_RE.test(s) ? s.toLowerCase() : null;
}

/** `table[data-user-width="60%"]` → `style.width = "60%"`. */
export function applyTableWidthsFromAttr(root: ParentNode): void {
    for (const el of root.querySelectorAll<HTMLElement>("table[data-user-width]")) {
        const pct = el.dataset.userWidth;
        if (pct && TABLE_WIDTH_PCT.test(pct)) el.style.width = pct;
    }
}

/** `tr[data-user-height="48px"]` → `style.height = "48px"`. */
export function applyRowHeightsFromAttr(root: ParentNode): void {
    for (const el of root.querySelectorAll<HTMLElement>("tr[data-user-height]")) {
        const px = el.dataset.userHeight;
        if (px && ROW_HEIGHT_PX.test(px)) el.style.height = px;
    }
}

/**
 * `table[data-tbl-*]` → the `--tbl-*` custom properties and the background. Borders and padding do
 * not inherit in CSS, so the properties are written on the `<table>` and every cell reads them with
 * a fallback (`app.css`, the export CSS). A `<caption>` is a real element and survives on its own.
 */
export function applyTablePropsFromAttr(root: ParentNode): void {
    for (const el of root.querySelectorAll<HTMLElement>("table")) {
        const d = el.dataset;
        const bw = pxInRange(d.tblBw, 10);
        if (bw !== null) el.style.setProperty("--tbl-bw", `${bw}px`);
        const bs = tableBorderStyle(d.tblBs);
        if (bs) el.style.setProperty("--tbl-bs", bs);
        const bc = tableColor(d.tblBc);
        if (bc) el.style.setProperty("--tbl-bc", bc);
        const pad = pxInRange(d.tblPad, 40);
        if (pad !== null) el.style.setProperty("--tbl-pad", `${pad}px`);
        const bg = tableColor(d.tblBg);
        if (bg) el.style.backgroundColor = bg;
    }
}

/**
 * `img[width="640px"]` → `style.width = "640px"; style.height = "auto"`. The image nodes store the
 * user's display width as a `width` attribute with a CSS unit (not a bare HTML pixel count), so the
 * attribute alone does nothing in a browser — the style has to be rebuilt.
 */
export function applyImageWidthsFromAttr(root: ParentNode): void {
    for (const el of root.querySelectorAll<HTMLElement>("img[width]")) {
        const w = el.getAttribute("width");
        if (w && IMAGE_WIDTH.test(w)) {
            el.style.width = w;
            el.style.height = "auto";
        }
    }
}

/** Everything a sanitised render needs: tables, rows, table properties and image widths. */
export function applyPresentationFromAttrs(root: ParentNode): void {
    applyTableWidthsFromAttr(root);
    applyRowHeightsFromAttr(root);
    applyTablePropsFromAttr(root);
    applyImageWidthsFromAttr(root);
}
