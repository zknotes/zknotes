// File references inside note HTML (`data-file-id`): pure string helpers. They live in core/utils
// rather than modules/files because the sync layer (conflict copies) and the item service need
// them, and core must not import modules/ — the golden rule events/file-bridge.ts spells out.

/** The prefix for files not yet uploaded: `local:<pendingUploadId>`. */
export const LOCAL_PREFIX = "local:";

export const FILE_ID_RE = /data-file-id="([^"]+)"/g;
// The encFile tags, void and paired — a regex rather than a DOMParser, so the same helper works in the
// browser and in the Node integration tests.
export const VOID_FILE_REF_SRC = String.raw`<(img|br|hr)\b[^>]*\bdata-file-id\s*=\s*["']([^"']*)["'][^>]*\/?>`;
export const PAIRED_FILE_REF_SRC = String.raw`\<([a-z][a-z0-9]*)\b[^>]*\bdata-file-id\s*=\s*["']([^"']*)["'][^>]*>[\s\S]*?<\/\1>`;

/**
 * Returns the distinct real fileIds referenced by an HTML string (a note's content, say).
 * `local:`-prefixed ids are pending uploads — not real items yet — and are skipped.
 */
export function extractFileRefs(content: unknown): string[] {
    if (typeof content !== "string" || content.length === 0) return [];
    const ids = new Set<string>();
    for (const m of content.matchAll(FILE_ID_RE)) {
        const id = m[1];
        if (id && !id.startsWith(LOCAL_PREFIX)) ids.add(id);
    }
    return [...ids];
}
/**
 * Removes EVERY encFile reference from an HTML string.
 * Used by note duplication and by the conflict copy — a file item cannot be shared between notes,
 * so a note's copy must not keep the `data-file-id` (or All Files and parent_id drift).
 */
export function stripAllFileRefsFromHtml(html: string): { html: string; strippedCount: number } {
    if (!html.includes("data-file-id")) return { html, strippedCount: 0 };

    const strippedCount = (html.match(/data-file-id\s*=/gi) ?? []).length;
    // A regex rather than a DOMParser — the same helper works in the browser and in the Node integration tests.
    // A new RegExp per loop — it avoids lastIndex on a shared /g object.
    let out = html;
    let prev = "";
    while (out !== prev) {
        prev = out;
        out = out
            .replace(new RegExp(VOID_FILE_REF_SRC, "gi"), "")
            .replace(new RegExp(PAIRED_FILE_REF_SRC, "gi"), "");
    }

    // No DOMPurify pass — the input is already vault HTML; we only remove the known encFile tags.
    return { html: out, strippedCount };
}
/**
 * A conflict copy drops the embeds (the 1:1 model — a sibling must not share a file).
 * The `keep_local` merge-back writes the offline HTML back into the ORIGINAL (the same id, the owner
 * of the files): the embed markup from the original that is missing from the offline content is
 * therefore restored, so the READY
 * files are not left with no `encFile` reference in the owning note.
 */
export function reattachEmbedsFromOriginal(offlineHtml: string, originalHtml: string): string {
    if (typeof offlineHtml !== "string") return offlineHtml;
    if (typeof originalHtml !== "string" || !originalHtml.includes("data-file-id")) {
        return offlineHtml;
    }

    const already = new Set(extractFileRefs(offlineHtml));
    const snippets: string[] = [];

    const collect = (source: string) => {
        const re = new RegExp(source, "gi");
        let m: RegExpExecArray | null = re.exec(originalHtml);
        while (m) {
            const fileId = m[2];
            const tag = m[0];
            if (fileId && !fileId.startsWith(LOCAL_PREFIX) && !already.has(fileId) && tag) {
                already.add(fileId);
                snippets.push(tag);
            }
            m = re.exec(originalHtml);
        }
    };
    collect(VOID_FILE_REF_SRC);
    collect(PAIRED_FILE_REF_SRC);

    if (snippets.length === 0) return offlineHtml;

    const appendix = snippets
        .map((tag) => (tag.trimStart().startsWith("<p") ? tag : `<p>${tag}</p>`))
        .join("");
    return offlineHtml + appendix;
}
