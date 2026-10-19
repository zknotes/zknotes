// The file-reference helpers — shared by the editor (the encFile node, the controller) and the note page.
// Lifted out of encfile-node.ts / editor-images.ts.

import type { Node as PMNode } from "@tiptap/pm/model";
import { extractFileRefs, LOCAL_PREFIX } from "$lib/core/utils/file-refs";
// The pure string helpers for file references live in core/utils/file-refs.ts: the sync layer and
// the item service need them too, and core must not import modules/ (events/file-bridge.ts). They
// stay exported from here for the files module's own callers.
export {
    extractFileRefs,
    LOCAL_PREFIX,
    reattachEmbedsFromOriginal,
    stripAllFileRefsFromHtml,
} from "$lib/core/utils/file-refs";

/**
 * Transaction meta for the upload pipeline re-pointing or dropping a `local:` node (the swap to the
 * real id, an Abort): the editor must not read it as the user removing that node.
 */
export const UPLOAD_REF_META = "uploadRefChange";

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
