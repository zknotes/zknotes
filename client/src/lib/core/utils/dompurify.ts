import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "strong",
    "b",
    "em",
    "i",
    "s",
    "del",
    "strike",
    "u",
    "mark",
    "sub",
    "sup",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "a",
    "img",
    "table",
    "caption",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "span",
    "div",
    "label",
    "input",
    // Lucide-style inline icons in the share file chips (no <script>, no foreignObject, …)
    "svg",
    "path",
    "circle",
    "line",
    "polyline",
    "polygon",
    "rect",
];

const ALLOWED_ATTR = [
    "href",
    "src",
    "alt",
    "title",
    "class",
    "id",
    "target",
    "rel",
    "data-file-id",
    "data-share-file-id",
    "data-share-download",
    "data-type",
    // TipTap math extension (markdown import / @aarkue/tiptap-math-extension)
    "data-latex",
    "data-display",
    "data-checked",
    "data-id",
    "type",
    "checked",
    "disabled",
    "colspan",
    "rowspan",
    "colwidth",
    // The table width in per cent. Inline `style` is stripped (CSS is not parsed);
    // this attribute is the only route to the width after sanitisation.
    "data-user-width",
    // The row height — the same reason as `data-user-width`.
    "data-user-height",
    // Table properties: border, background and padding. The carrier used to be
    // custom properties in the inline style, which sanitisation strips — these attributes
    // are the only remaining route.
    "data-tbl-bw",
    "data-tbl-bs",
    "data-tbl-bc",
    "data-tbl-bg",
    "data-tbl-pad",
    "role",
    "tabindex",
    "aria-hidden",
    "xmlns",
    "viewBox",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "points",
    "cx",
    "cy",
    "r",
    "x",
    "y",
    "width",
    "height",
    "rx",
    "ry",
];

/** Default DOMPurify URI schemes — http(s)/mailto/tel/…, never data: or blob:. */
const SAFE_URI_REGEXP =
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

const MEDIA_SRC_TAGS = new Set(["IMG", "VIDEO", "AUDIO"]);

type AttrHookData = {
    attrName: string;
    attrValue: string;
    keepAttr: boolean;
    forceKeepAttr?: boolean;
};

function uponSanitizeAttribute(node: Element, data: AttrHookData, share: boolean): void {
    if (data.attrName === "src" && MEDIA_SRC_TAGS.has(node.nodeName)) {
        if (/^(?:blob:|data:)/i.test(data.attrValue || "")) {
            // blob: is not in SAFE_URI_REGEXP; forceKeepAttr bypasses the URI check for media src.
            data.forceKeepAttr = true;
            return;
        }
        if (share && node.nodeName === "IMG") {
            data.keepAttr = false;
        }
    }
}

function uponSanitizeElement(node: Node): void {
    if (node.nodeName !== "INPUT" || !("getAttribute" in node)) return;
    const el = node as Element;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type !== "checkbox") {
        el.remove();
        return;
    }
    el.setAttribute("disabled", "");
}

function afterSanitizeAttributes(node: Element): void {
    if (node.nodeName === "A" && node.hasAttribute("target")) {
        // Only a new tab, and always without an opener or a referrer; a named or `_self`/`_top`
        // target would keep whatever `rel` the content chose.
        if (node.getAttribute("target") === "_blank") {
            node.setAttribute("rel", "noopener noreferrer");
        } else {
            node.removeAttribute("target");
            node.removeAttribute("rel");
        }
    }
    if (
        node.nodeName === "INPUT" &&
        (node.getAttribute("type") || "").toLowerCase() === "checkbox"
    ) {
        node.setAttribute("disabled", "");
    }
}

function sanitizeWithHooks(html: string, share: boolean): string {
    DOMPurify.addHook("uponSanitizeAttribute", ((node: Element, data: AttrHookData) => {
        uponSanitizeAttribute(node, data, share);
    }) as never);
    DOMPurify.addHook("uponSanitizeElement", uponSanitizeElement as never);
    DOMPurify.addHook("afterSanitizeAttributes", afterSanitizeAttributes as never);
    try {
        return DOMPurify.sanitize(html, {
            ALLOWED_TAGS,
            ALLOWED_ATTR,
            ALLOWED_URI_REGEXP: SAFE_URI_REGEXP,
            ADD_DATA_URI_TAGS: ["img"],
        });
    } finally {
        DOMPurify.removeHook("uponSanitizeAttribute");
        DOMPurify.removeHook("uponSanitizeElement");
        DOMPurify.removeHook("afterSanitizeAttributes");
    }
}

/** Escapes the special HTML characters, for inserting text into an HTML context safely. */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Strict sanitisation of the HTML coming out of notes (TipTap content).
 * It guards against XSS by blocking everything not on the allow-list.
 */
export function sanitizeHtml(html: string): string {
    return sanitizeWithHooks(html, false);
}

/**
 * Stricter sanitisation for the public share render (`/s/:id`) — defence in depth alongside the CSP.
 * - no `style` (a tracking pixel through background:url)
 * - `<img src>` only `blob:` / `data:` (the attachments are hydrated into a blob URL anyway)
 * - `target=_blank` gets `rel="noopener noreferrer"`
 */
export function sanitizeShareHtml(html: string): string {
    return sanitizeWithHooks(html, true);
}

/**
 * Sanitises SVG images so they can be shown inline safely, by stripping nested
 * <script> elements and onerror handlers.
 */
export function sanitizeSvg(svgText: string): string {
    return DOMPurify.sanitize(svgText, {
        USE_PROFILES: { svg: true },
    });
}
