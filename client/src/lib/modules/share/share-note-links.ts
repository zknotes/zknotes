const INTERNAL_NOTE_ID_RE = /data-note-id="([^"]+)"/g;

/** How many unique internal note links the HTML content holds. */
export function countInternalNoteLinks(content: string): number {
    const ids = new Set<string>();
    for (const m of content.matchAll(INTERNAL_NOTE_ID_RE)) {
        const id = m[1];
        if (id) ids.add(id);
    }
    return ids.size;
}

/**
 * Replaces clickable internal note links with references that cannot be clicked.
 * Whoever receives a share link has no access to the other notes in the vault.
 */
export function neutralizeInternalNoteLinks(html: string): string {
    if (!html.includes("data-note-id") || typeof document === "undefined") {
        return html;
    }

    const doc = new DOMParser().parseFromString(`<div id="share-root">${html}</div>`, "text/html");
    const root = doc.getElementById("share-root");
    if (!root) return html;

    for (const anchor of [...root.querySelectorAll("a[data-note-id]")]) {
        const span = doc.createElement("span");
        span.className = "share-note-ref";
        span.title = "Not included in this share";
        const label = anchor.textContent?.trim();
        span.textContent = label || "Linked note";
        anchor.parentNode?.replaceChild(span, anchor);
    }

    return root.innerHTML;
}
