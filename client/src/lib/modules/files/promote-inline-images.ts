// Auto-vault TipTap inline `data:image` → encFile.
// A synchronous HTML rewrite (the ids), an async staging of the bytes, a remote „Add to Files“.

import type { Editor } from "@tiptap/core";
import { uuidv7 } from "uuidv7";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { devLog, devWarn } from "$lib/core/utils/dev-log";
import { preparePendingUpload } from "./editor-images";
import { exceedsKnownFileSizeLimit, getMaxFileSize } from "./limits";
import {
    clearNotePromote,
    getOrCreatePromoteAbort,
    trackInFlight,
    untrackInFlight,
} from "./promote-inflight";
import { LOCAL_PREFIX } from "./refs";
import { startUpload } from "./upload-manager";

const STAGING_WATCHDOG_MS = 60_000;
const REMOTE_FETCH_TIMEOUT_MS = 60_000;

export type PromoteJob = {
    localId: string;
    dataUrl: string;
    alt: string;
    approxBytes: number;
};

const DATA_IMAGE_PREFIX = "data:image/";

/** A rough size from the base64 length, before decoding. */
function approxBytesFromDataUrl(dataUrl: string): number {
    const comma = dataUrl.indexOf(",");
    const b64Len = comma === -1 ? dataUrl.length : dataUrl.length - comma - 1;
    return Math.floor((b64Len * 3) / 4);
}

function extFromMime(mime: string): string {
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("gif")) return "gif";
    if (mime.includes("svg")) return "svg";
    return "png";
}

function fileNameFromAlt(alt: string, mime: string): string {
    const base = (alt || "image").replace(/[^\w.\-]+/g, "_").slice(0, 64) || "image";
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(base)) return base;
    return `${base}.${extFromMime(mime)}`;
}

async function dataUrlToFile(dataUrl: string, alt: string): Promise<File | null> {
    try {
        const blob = await fetch(dataUrl).then((r) => r.blob());
        if (!blob.type.startsWith("image/")) return null;
        return new File([blob], fileNameFromAlt(alt, blob.type), { type: blob.type });
    } catch {
        return null;
    }
}

/**
 * SYNCHRONOUS: replace the data:image tags with data-file-id="local:…".
 * Above the max size → skipped (replaceHugeDataImageTags later).
 * Surgical: only the src attribute becomes data-file-id; width and alt stay.
 */
export function rewriteDataImagesInHtml(html: string): {
    html: string;
    jobs: PromoteJob[];
    skipped: number;
} {
    if (!html.includes("<img") || !html.includes("data:image")) {
        return { html, jobs: [], skipped: 0 };
    }

    const jobs: PromoteJob[] = [];
    let skipped = 0;
    let out = "";
    let i = 0;

    while (i < html.length) {
        const imgStart = html.indexOf("<img", i);
        if (imgStart === -1) {
            out += html.slice(i);
            break;
        }
        out += html.slice(i, imgStart);

        // Already an encFile?
        const headPeek = html.slice(imgStart, imgStart + 96);
        if (/data-file-id\s*=/i.test(headPeek)) {
            const close = html.indexOf(">", imgStart);
            if (close === -1) {
                out += html.slice(imgStart);
                break;
            }
            out += html.slice(imgStart, close + 1);
            i = close + 1;
            continue;
        }

        const srcAttrIdx = html.indexOf("src=", imgStart);
        const qChar = srcAttrIdx >= 0 ? html[srcAttrIdx + 4] : "";
        if (srcAttrIdx === -1 || srcAttrIdx > imgStart + 400 || (qChar !== '"' && qChar !== "'")) {
            const close = html.indexOf(">", imgStart);
            if (close === -1) {
                out += html.slice(imgStart);
                break;
            }
            out += html.slice(imgStart, close + 1);
            i = close + 1;
            continue;
        }
        const q = qChar;
        const valueStart = srcAttrIdx + 5;
        let valueEnd = valueStart;
        while (valueEnd < html.length && html[valueEnd] !== q) valueEnd++;
        const dataUrl = html.slice(valueStart, valueEnd);

        let tagEnd = valueEnd + 1;
        while (tagEnd < html.length && html[tagEnd] !== ">") tagEnd++;
        if (tagEnd >= html.length) {
            out += html.slice(imgStart);
            break;
        }

        if (!dataUrl.startsWith(DATA_IMAGE_PREFIX)) {
            out += html.slice(imgStart, tagEnd + 1);
            i = tagEnd + 1;
            continue;
        }

        const approxBytes = approxBytesFromDataUrl(dataUrl);
        // An unknown limit skips nothing: the image is promoted and the server decides.
        if (exceedsKnownFileSizeLimit(approxBytes)) {
            skipped++;
            out += html.slice(imgStart, tagEnd + 1);
            i = tagEnd + 1;
            continue;
        }

        const tagSlice = html.slice(imgStart, tagEnd + 1);
        const altMatch = tagSlice.match(/\balt\s*=\s*["']([^"']*)["']/i);
        const alt = altMatch?.[1] ?? "image";
        const localId = uuidv7();

        // Surgical: remove the whole src="…" and put data-file-id="local:…" in its place
        const srcAttrEnd = valueEnd + 1; // includes the closing quote
        const beforeSrc = html.slice(imgStart, srcAttrIdx);
        const afterSrc = html.slice(srcAttrEnd, tagEnd + 1);
        // Trim the redundant space before src
        const beforeTrim = beforeSrc.replace(/\s+$/, " ");
        out += `${beforeTrim}data-file-id="${LOCAL_PREFIX}${localId}"${afterSrc}`;

        jobs.push({ localId, dataUrl, alt, approxBytes });
        i = tagEnd + 1;
    }

    return { html: out, jobs, skipped };
}

/** Rolls an encFile local: back → a TipTap image with the original data: (no undo history). */
function rollbackToDataImage(editor: Editor, localId: string, dataUrl: string, alt: string): void {
    if (editor.isDestroyed) return;
    const fileId = LOCAL_PREFIX + localId;
    const { state, view } = editor;
    const imageType = state.schema.nodes.image;
    if (!imageType) return;

    let tr = state.tr;
    let changed = false;
    state.doc.descendants((node, pos) => {
        if (node.type.name === "encFile" && node.attrs.fileId === fileId) {
            tr = tr.setNodeMarkup(pos, imageType, {
                src: dataUrl,
                alt: alt || node.attrs.alt || null,
                width: node.attrs.width ?? null,
            });
            changed = true;
        }
    });
    if (changed) {
        tr.setMeta("addToHistory", false);
        view.dispatch(tr);
    }
}

/**
 * ASYNCHRONOUS: decode → preparePendingUpload(localId) → startUpload.
 * On failure → roll back to data:; the in-flight track/untrack happens per job.
 */
export async function stagePromotedImages(
    editor: Editor,
    jobs: PromoteJob[],
    noteId: string,
    parentId: string | null,
): Promise<{ promoted: number; failed: number }> {
    if (jobs.length === 0) return { promoted: 0, failed: 0 };

    const signal = getOrCreatePromoteAbort(noteId);
    let promoted = 0;
    let failed = 0;

    // Sequentially — a smaller memory spike
    for (const job of jobs) {
        if (signal.aborted || editor.isDestroyed) {
            failed += jobs.length - promoted - failed;
            break;
        }

        trackInFlight(noteId, {
            localId: job.localId,
            dataUrl: job.dataUrl,
            alt: job.alt,
        });

        const watchdog = setTimeout(() => {
            devWarn("promote", "staging watchdog 60s → fail", job.localId);
        }, STAGING_WATCHDOG_MS);

        try {
            if (signal.aborted) throw new Error("aborted");

            const file = await dataUrlToFile(job.dataUrl, job.alt);
            if (!file) throw new Error("not an image");

            if (signal.aborted) throw new Error("aborted");

            const pending = await Promise.race([
                preparePendingUpload(file, noteId, parentId, { localId: job.localId }),
                new Promise<never>((_, reject) => {
                    const t = setTimeout(
                        () => reject(new Error("staging timeout")),
                        STAGING_WATCHDOG_MS,
                    );
                    signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(t);
                            reject(new Error("aborted"));
                        },
                        { once: true },
                    );
                }),
            ]);

            if (signal.aborted || editor.isDestroyed) {
                // The staging exists in IDB — startUpload can continue on a resume; but the node may
                // disappear. On an abort (an external pull), clearNote has already run; do not roll back
                // the wrong doc.
                throw new Error("aborted");
            }

            startUpload(editor, pending);
            promoted++;
            devLog("promote", "staged →", job.localId);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg !== "aborted" && !editor.isDestroyed) {
                rollbackToDataImage(editor, job.localId, job.dataUrl, job.alt);
                failed++;
                devWarn("promote", "stage failed, rollback", job.localId, msg);
            }
            // aborted: an external cancel — do not touch the doc
        } finally {
            clearTimeout(watchdog);
            untrackInFlight(noteId, job.localId);
        }
    }

    if (failed > 0 && !signal.aborted) {
        globalToasts.add({
            variant: "error",
            message:
                failed === 1
                    ? "Could not vault one inline image. It stays embedded in the note."
                    : `Could not vault ${failed} inline images. They stay embedded in the note.`,
        });
    }

    return { promoted, failed };
}

/** Reads a response body with a cap at getMaxFileSize() — it works without a Content-Length too. */
async function fetchImageBlobCapped(url: string, signal: AbortSignal): Promise<Blob> {
    const maxBytes = getMaxFileSize();
    const res = await fetch(url, { mode: "cors", signal, credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const cl = res.headers.get("content-length");
    if (cl) {
        const n = Number(cl);
        if (Number.isFinite(n) && n > maxBytes) throw new Error("too large");
    }

    if (!res.body) {
        const blob = await res.blob();
        if (blob.size > maxBytes) throw new Error("too large");
        if (
            !blob.type.startsWith("image/") &&
            blob.type !== "" &&
            blob.type !== "application/octet-stream"
        ) {
            throw new Error("not an image");
        }
        return blob;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw new Error("too large");
            }
            chunks.push(value);
        }
    }
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    return new Blob(chunks as BlobPart[], { type: mime });
}

/**
 * The user’s „Add to Files": remote http(s) image nodes → encFile + upload.
 */
export async function promoteRemoteImagesInEditor(
    editor: Editor,
    noteId: string,
    parentId: string | null,
): Promise<{ promoted: number; failed: number }> {
    if (editor.isDestroyed) return { promoted: 0, failed: 0 };

    type Hit = { pos: number; src: string; alt: string; width: string | null };
    const hits: Hit[] = [];
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "image") return true;
        const src = node.attrs.src as string | null;
        if (!src || !/^https?:\/\//i.test(src)) return true;
        hits.push({
            pos,
            src,
            alt: (node.attrs.alt as string) || "image",
            width: (node.attrs.width as string) || null,
        });
        return true;
    });

    // data: whatever is left (a size skip followed by a huge placeholder — the button does not rescue a placeholder)
    // and the remaining small data: edge cases
    editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "image") return true;
        const src = node.attrs.src as string | null;
        if (!src || !src.startsWith(DATA_IMAGE_PREFIX)) return true;
        if (exceedsKnownFileSizeLimit(approxBytesFromDataUrl(src))) return true;
        hits.push({
            pos,
            src,
            alt: (node.attrs.alt as string) || "image",
            width: (node.attrs.width as string) || null,
        });
        return true;
    });

    if (hits.length === 0) return { promoted: 0, failed: 0 };

    let promoted = 0;
    let failed = 0;
    // Process from end so positions stay valid when replacing
    hits.sort((a, b) => b.pos - a.pos);

    for (const hit of hits) {
        if (editor.isDestroyed) break;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), REMOTE_FETCH_TIMEOUT_MS);
        const localId = uuidv7();
        const fileId = LOCAL_PREFIX + localId;

        try {
            let file: File;
            if (hit.src.startsWith(DATA_IMAGE_PREFIX)) {
                const f = await dataUrlToFile(hit.src, hit.alt);
                if (!f) throw new Error("not an image");
                file = f;
            } else {
                const blob = await fetchImageBlobCapped(hit.src, ac.signal);
                const mime = blob.type.startsWith("image/") ? blob.type : "image/png";
                file = new File([blob], fileNameFromAlt(hit.alt, mime), { type: mime });
            }

            // Replace image → encFile local: before the staging
            const { state, view } = editor;
            const encType = state.schema.nodes.encFile;
            if (!encType) throw new Error("no encFile");
            const live = state.doc.nodeAt(hit.pos);
            if (!live || live.type.name !== "image") {
                // The doc changed
                failed++;
                continue;
            }
            let tr = state.tr.setNodeMarkup(hit.pos, encType, {
                fileId,
                alt: hit.alt,
                mime: file.type,
                width: hit.width,
            });
            tr.setMeta("addToHistory", false);
            view.dispatch(tr);

            trackInFlight(noteId, { localId, dataUrl: hit.src, alt: hit.alt });
            try {
                const pending = await preparePendingUpload(file, noteId, parentId, {
                    localId,
                });
                untrackInFlight(noteId, localId);
                if (!editor.isDestroyed) startUpload(editor, pending);
                promoted++;
            } catch (e) {
                untrackInFlight(noteId, localId);
                rollbackToDataImage(editor, localId, hit.src, hit.alt);
                throw e;
            }
        } catch (e) {
            failed++;
            devWarn("promote", "remote promote fail", hit.src.slice(0, 80), e);
        } finally {
            clearTimeout(timer);
        }
    }

    if (failed > 0) {
        globalToasts.add({
            variant: "error",
            message:
                promoted === 0
                    ? "Could not add images to Files. Images from other sites are blocked here — save them and upload them instead."
                    : `Added ${promoted}, failed ${failed}. Some images stay inline.`,
        });
    } else if (promoted > 0) {
        globalToasts.add({
            variant: "success",
            message:
                promoted === 1 ? "Image added to Files." : `${promoted} images added to Files.`,
        });
    }

    return { promoted, failed };
}

/** Abort a note's in-flight promote (external pull / switch). */
export function cancelPromoteForNote(noteId: string): void {
    clearNotePromote(noteId);
}

// A re-export for NoteAutosave (the same module surface)
export {
    clearNotePromote,
    inFlightPromoteCount,
    restoreInFlightDataUrls,
} from "./promote-inflight";
