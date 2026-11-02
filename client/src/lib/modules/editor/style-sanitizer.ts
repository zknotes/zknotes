// The inline styles a note's HTML may carry into the editor. TipTap turns `style="color: X"`,
// `data-color="X"` and the like back into marks and renders X into a style attribute again, so a
// value such as `red; background: url(...)` from a restored backup or a crafted paste would land in
// the page as CSS of the attacker's choosing. The sign-in-protected note is the user's own, but a
// backup, a Markdown import or a share can carry someone else's HTML — so every load is filtered
// through one allow-list: the properties the editor really uses, each with a value grammar.
//
// DOMPurify (core/utils/dompurify.ts) is not the tool here: it strips every `style`, which the
// editor's colours, fonts and alignment depend on; the share page and the exports use it.

/** A CSS colour the editor writes: hex, rgb()/rgba()/hsl()/hsla() with plain numbers, or a name. */
const COLOR =
    /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\(\s*[\d.%]+\s*,?\s*[\d.%]+\s*,?\s*[\d.%]+\s*(,|\/)?\s*[\d.%]*\s*\)|[a-z]{3,20}|inherit|transparent|currentcolor)$/i;
/** A font-family list: names, optionally quoted, separated by commas. */
const FONT_FAMILY = /^[a-z0-9 ,'"\-]{1,120}$/i;
/** A length or keyword a font-size can be. */
const FONT_SIZE =
    /^(\d{1,3}(\.\d+)?(px|pt|em|rem|%)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i;
const ALIGN = /^(left|right|center|justify)$/i;
/** A width / height the table controls write: a length or a percentage. */
const LENGTH = /^\d{1,5}(\.\d+)?(px|%|em|rem)?$/;

const ALLOWED_STYLE: Record<string, RegExp> = {
    color: COLOR,
    "background-color": COLOR,
    "font-family": FONT_FAMILY,
    "font-size": FONT_SIZE,
    "text-align": ALIGN,
    width: LENGTH,
    height: LENGTH,
    "min-width": LENGTH,
};

/** Attributes TipTap reads a colour from. */
const COLOR_ATTRS = ["data-color"];

/** The style string with only the allowed declarations, or null when nothing survives. */
export function sanitizeStyleDeclarations(style: string): string | null {
    const kept: string[] = [];
    for (const decl of style.split(";")) {
        const colon = decl.indexOf(":");
        if (colon < 0) continue;
        const prop = decl.slice(0, colon).trim().toLowerCase();
        const value = decl.slice(colon + 1).trim();
        const grammar = ALLOWED_STYLE[prop];
        if (!grammar || !grammar.test(value)) continue;
        kept.push(`${prop}: ${value}`);
    }
    return kept.length > 0 ? kept.join("; ") : null;
}

/**
 * The note HTML with every inline style and colour attribute reduced to the allow-list above, and
 * links stripped of the presentation attributes the editor sets itself. Everything else is left
 * exactly as it was — this is not DOMPurify.
 */
export function sanitizeEditorStyles(html: string): string {
    if (
        !html ||
        (!html.includes("style") && !html.includes("data-color") && !html.includes("<a"))
    ) {
        return html;
    }
    if (typeof DOMParser === "undefined") return html;
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    for (const el of doc.body.querySelectorAll("[style]")) {
        const clean = sanitizeStyleDeclarations(el.getAttribute("style") ?? "");
        if (clean) el.setAttribute("style", clean);
        else el.removeAttribute("style");
    }
    for (const attr of COLOR_ATTRS) {
        for (const el of doc.body.querySelectorAll(`[${attr}]`)) {
            const v = el.getAttribute(attr) ?? "";
            if (!COLOR.test(v.trim())) el.removeAttribute(attr);
        }
    }
    // A link's class, target and rel come from the Link extension's own configuration on render;
    // values carried in the HTML would otherwise override them (a `rel` without noopener, say).
    for (const a of doc.body.querySelectorAll("a")) {
        a.removeAttribute("class");
        a.removeAttribute("target");
        a.removeAttribute("rel");
    }
    return doc.body.innerHTML;
}
