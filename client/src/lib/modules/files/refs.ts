// The file-reference helpers — shared by the editor (the encFile node, the controller) and the note page.
// Lifted out of encfile-node.ts / editor-images.ts.

import type { Node as PMNode } from "@tiptap/pm/model";

/** The prefix for files not yet uploaded: `local:<pendingUploadId>`. */
export const LOCAL_PREFIX = "local:";

/**
 * Transaction meta for the upload pipeline re-pointing or dropping a `local:` node (the swap to the
 * real id, an Abort): the editor must not read it as the user removing that node.
 */
export const UPLOAD_REF_META = "uploadRefChange";

const FILE_ID_RE = /data-file-id="([^"]+)"/g;

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
 * The same as `extractFileRefs`, but from a ProseMirror doc — with no `getHTML()` serialisation
 * (which is expensive on every keystroke with multi-MB embeds).
 */
export function extractFileRefsFromDoc(doc: PMNode): string[] {
    const ids = new Set<string>();
    doc.descendants((node) => {
        if (node.type.name !== "encFile") return true;
        const id = node.attrs.fileId as string | null | undefined;
        if (id && !id.startsWith(LOCAL_PREFIX)) ids.add(id);
        return true;
    });
    return [...ids];
}

/** Merges the live editor refs and the saved payload (a union) — it avoids an either-or drift. */
export function mergeAttachmentFileIds(liveIds: string[], payloadContent: unknown): string[] {
    return [...new Set([...liveIds, ...extractFileRefs(payloadContent)])];
}

// Source strings (not a shared /g RegExp) — `lastIndex` on a global regex breaks consecutive calls.
const VOID_FILE_REF_SRC = String.raw`<(img|br|hr)\b[^>]*\bdata-file-id\s*=\s*["']([^"']*)["'][^>]*\/?>`;
const PAIRED_FILE_REF_SRC = String.raw`\<([a-z][a-z0-9]*)\b[^>]*\bdata-file-id\s*=\s*["']([^"']*)["'][^>]*>[\s\S]*?<\/\1>`;

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

/**
 * TipTap `image` nodes (a src URL/base64) without a `data-file-id` — they are visible in the note but
 * are not vault files, so they appear in neither /files nor the attachment badge.
 * Returns an exact N — only a fixed head window per tag; it does not scan the base64 body.
 */
const IMG_TAG_HEAD = 320;

export function countInlineExternalImages(content: unknown): number {
    if (typeof content !== "string" || content.length === 0) return 0;
    if (!content.includes("<img")) return 0;
    let count = 0;
    let pos = content.indexOf("<img");
    while (pos !== -1) {
        const nextImg = content.indexOf("<img", pos + 4);
        const headEnd = nextImg === -1 ? pos + IMG_TAG_HEAD : Math.min(pos + IMG_TAG_HEAD, nextImg);
        const head = content.slice(pos, headEnd);
        if (!/data-file-id\s*=/i.test(head) && /\bsrc\s*=/i.test(head)) count++;
        pos = nextImg;
    }
    return count;
}

/** The number of TipTap `image` nodes in the live doc (without getHTML / base64 serialisation). */
export function countInlineExternalImagesFromDoc(doc: PMNode): number {
    let count = 0;
    doc.descendants((node) => {
        if (node.type.name === "image" && node.attrs.src) count++;
        return true;
    });
    return count;
}

/** The threshold for an inline data: src — above it, swap in a placeholder before TipTap's loadContent. */
const HUGE_INLINE_DATA_SRC = 64 * 1024;

/**
 * Replaces huge inline `data:image` <img> tags with placeholder text.
 * A one-off O(n) pass when a note opens — it prevents a TipTap freeze or crash.
 */
export function replaceHugeDataImageTags(html: string): string {
    if (!html.includes("data:image") || !html.includes("<img")) return html;

    let out = "";
    let i = 0;
    while (i < html.length) {
        const imgStart = html.indexOf("<img", i);
        if (imgStart === -1) {
            out += html.slice(i);
            break;
        }
        out += html.slice(i, imgStart);

        const head = html.slice(imgStart, imgStart + 96);
        if (!/\bsrc\s*=\s*["']data:image\//i.test(head)) {
            const close = html.indexOf(">", imgStart);
            if (close === -1) {
                out += html.slice(imgStart);
                break;
            }
            out += html.slice(imgStart, close + 1);
            i = close + 1;
            continue;
        }

        const srcIdx = html.indexOf("src=", imgStart);
        const quote = html[srcIdx + 4] === "'" ? "'" : '"';
        const valueStart = srcIdx + 5;
        let valueEnd = valueStart;
        while (valueEnd < html.length && html[valueEnd] !== quote) valueEnd++;
        const srcLen = valueEnd - valueStart;

        let tagEnd = valueEnd + 1;
        while (tagEnd < html.length && html[tagEnd] !== ">") tagEnd++;

        if (srcLen > HUGE_INLINE_DATA_SRC) {
            const altMatch = html.slice(imgStart, tagEnd).match(/alt\s*=\s*["']([^"']*)["']/i);
            const alt = altMatch?.[1] ?? "image";
            const kb = Math.round(srcLen / 1024);
            out += `<p><em>[Inline image "${alt}" (${kb} KB) — remove this line and re-insert via drag &amp; drop to store in Files]</em></p>`;
        } else {
            out += html.slice(imgStart, tagEnd + 1);
        }
        i = tagEnd + 1;
    }
    return out;
}
