// A custom TipTap node for encrypted file references. Instead of inline base64 image
// bytes in the note payload, a note stores only the reference `<img data-file-id="…">`. The NodeView
// resolves that reference into a decrypted `blob:` URL at render time:
//   - `local:<id>`  → the plaintext Blob from the `pending-uploads` IDB store (instant, pre-upload)
//   - `<fileItemId>`→ decrypt the file-manager item through the worker
// Every blob: URL it creates is revoked in destroy()/on update (no RAM leaks).
//
// The DOM builders (the file chip, the upload overlay) live in ./enc-file-chip.ts and
// ./enc-file-overlay.ts; this file holds the TipTap definition and the NodeView lifecycle (the
// disposed/currentFileId race guards are subtle — change them carefully).

import { mergeAttributes, Node, type NodeViewRendererProps } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { APP_EVENTS } from "$lib/core/constants/events";
import { onFileInvalidated } from "$lib/modules/files/file-invalidator";
import { LOCAL_PREFIX } from "$lib/modules/files/refs";
import { isRasterImageMime } from "$lib/modules/files/sniff";
import {
    abortPendingUpload,
    getUploadState,
    retryUpload,
    subscribeUpload,
} from "$lib/modules/files/upload-manager";
import { CHIP_NAME_ATTR, makeFileChip, makePendingFileChip } from "./enc-file-chip";
import { makeUploadOverlay } from "./enc-file-overlay";
import { OverlaySlot } from "./enc-file-overlay-slot";
import { ResizeController } from "./enc-file-resize";
import { ToolbarController } from "./enc-file-toolbar";

/**
 * Resolves a node's `data-file-id` into a URL that can be displayed.
 * - `local:<id>` → a fresh object URL over the pending-upload Blob (owned by this node → revoke it).
 * - `<fileItemId>` → a shared URL from the central blob cache → release, do not revoke.
 *
 * The teardown is chosen from TWO independent flags — do not derive it from `url`/`owned`:
 * - `owned: true`  → the NodeView revokes its own object URL
 * - `acquired: true` → the NodeView MUST call `blob-cache.release()` exactly once
 *
 * `acquired` has to be a separate flag because `acquire()` legitimately returns `url: null` (a
 * declared image the sniff rules download-only) — the ref was taken and has to be released. The
 * other way round, the stream / chip / unplayable branches return without acquiring at all, so a
 * release on them decrements ANOTHER consumer's ref (a grid card, the detail panel) and revokes the
 * URL out from under its live image.
 */
export async function resolveUrl(fileId: string): Promise<{
    url: string | null;
    owned: boolean;
    acquired?: boolean;
    name?: string;
    stream?: boolean;
}> {
    if (fileId.startsWith(LOCAL_PREFIX)) {
        const localId = fileId.slice(LOCAL_PREFIX.length);
        const { getDB } = await import("$lib/core/db");
        const { isStagingComplete, createSourcePreviewUrl } = await import(
            "$lib/modules/files/opfs-staging"
        );
        const db = await getDB();
        const pending = await db.get("pending-uploads", localId);
        if (!pending) throw new Error("pending upload not found");

        if (isStagingComplete(pending) && pending.staging_id) {
            const url = await createSourcePreviewUrl(
                pending.staging_id,
                pending.mime,
                pending.plain_size ?? 0,
            );
            return { url, owned: true, name: pending.name };
        }
        if (pending.blob) {
            return { url: URL.createObjectURL(pending.blob), owned: true, name: pending.name };
        }
        throw new Error("pending upload not found");
    }
    const { getFilePayload } = await import("$lib/modules/files/download");
    const payload = await getFilePayload(fileId);
    const name = payload?.name;
    const mime = payload?.mime;

    if (mime?.startsWith("video/") || mime?.startsWith("audio/")) {
        // Render a player only for the containers and codecs this browser really decodes (an AVI, for
        // instance, decrypts and streams but no browser plays it — it has to fall back to a download
        // chip, not a dead player). canPlayType("") means unsupported.
        const probe = document.createElement(mime.startsWith("video/") ? "video" : "audio");
        if (probe.canPlayType(mime)) {
            // A stream URL works ONLY through the SW — with no controller the browser gets a 404 and a media error.
            const { ensureStreamServiceWorker } = await import("$lib/core/streaming/sw-bridge");
            const swOk = await ensureStreamServiceWorker();
            if (!swOk) {
                // No SW (an old browser, a failed registration) → a chip with a download, not a dead player.
                return { url: null, owned: false, name };
            }
            return { url: `/zknotes/stream/${fileId}`, owned: false, name, stream: true };
        }
        // Unplayable media → a download-only chip; skip the blob cache (there is no point decrypting the bytes).
        return { url: null, owned: false, name };
    }

    // A declared non-image (a PDF, an archive, a docx…) → a download chip with not one chunk fetched;
    // acquire would download the ENTIRE file only for the sniff to conclude "download" (an
    // anti-pattern). Two cases still go through acquire: declared images (the sniff gate
    // decides whether they really render) and a null payload (a deleted file, a decrypt error —
    // acquire throws the FileDeletedError that load()'s catch handler relies on).
    if (payload && !isRasterImageMime(mime)) {
        return { url: null, owned: false, name };
    }

    const { acquire } = await import("$lib/modules/files/blob-cache");
    const { url } = await acquire(fileId);
    return { url, owned: false, acquired: true, name };
}

export const EncFile = Node.create({
    name: "encFile",
    group: "block",
    atom: true,
    draggable: true,

    addAttributes() {
        return {
            fileId: {
                default: null,
                parseHTML: (el) => (el as HTMLElement).getAttribute("data-file-id"),
                renderHTML: (attrs) => (attrs.fileId ? { "data-file-id": attrs.fileId } : {}),
            },
            alt: {
                default: null,
                parseHTML: (el) => (el as HTMLElement).getAttribute("alt"),
                renderHTML: (attrs) => (attrs.alt ? { alt: attrs.alt } : {}),
            },
            // The declared MIME on the node, so non-image files render as chips without decryption.
            mime: {
                default: null,
                parseHTML: (el) => (el as HTMLElement).getAttribute("data-mime"),
                renderHTML: (attrs) => (attrs.mime ? { "data-mime": attrs.mime } : {}),
            },
            // Set on >50 MB drops for an inline error without attempting an upload.
            error: {
                default: null,
                parseHTML: (el) => (el as HTMLElement).getAttribute("data-error"),
                renderHTML: (attrs) => (attrs.error ? { "data-error": attrs.error } : {}),
            },
            // The user-set display width ("640px", say). Stored as an attribute plus an inline style.
            width: {
                default: null,
                parseHTML: (el) => (el as HTMLElement).getAttribute("width") || null,
                renderHTML: (attrs) =>
                    attrs.width
                        ? { width: attrs.width, style: `width:${attrs.width};height:auto;` }
                        : {},
            },
            // The original's intrinsic dimensions in pixels (anti-CLS). Separate from
            // `width`, which is the *display* width as a CSS string. These two give the ratio, so the
            // NodeView reserves exactly the right space BEFORE decrypting any bytes — otherwise the
            // content below the image jumps.
            // They are carried in the note HTML so they are available synchronously, with nothing decrypted.
            w: {
                default: null,
                parseHTML: (el) => {
                    const v = Number((el as HTMLElement).getAttribute("data-w"));
                    return Number.isFinite(v) && v > 0 ? v : null;
                },
                renderHTML: (attrs) => (attrs.w ? { "data-w": String(attrs.w) } : {}),
            },
            h: {
                default: null,
                parseHTML: (el) => {
                    const v = Number((el as HTMLElement).getAttribute("data-h"));
                    return Number.isFinite(v) && v > 0 ? v : null;
                },
                renderHTML: (attrs) => (attrs.h ? { "data-h": String(attrs.h) } : {}),
            },
        };
    },

    parseHTML() {
        return [{ tag: "img[data-file-id]", priority: 100 }];
    },

    renderHTML({ HTMLAttributes }) {
        return ["img", mergeAttributes(HTMLAttributes)];
    },

    addNodeView() {
        return (props: NodeViewRendererProps) => {
            // `node` is MUTABLE: props.node is only a snapshot from the mount, and update() refreshes
            // it. Without that, load(), syncToolbar() and the catch branch read a stale alt, mime or
            // error (after a local:→uuid swap or a rename transaction) and show the name from the
            // first render.
            let node = props.node;
            const editor = props.editor,
                getPos = props.getPos;
            const dom = document.createElement("span");
            // fit-content shrinks the dom to the image's exact width, rather than a full-row block.
            dom.style.cssText = "position:relative;display:block;width:fit-content;";

            const applyAlign = () => {
                const align = node.attrs.textAlign;
                if (align === "center") {
                    dom.style.margin = "1.2em auto";
                } else if (align === "right") {
                    dom.style.margin = "1.2em 0 1.2em auto";
                } else {
                    dom.style.margin = "1.2em 0";
                }
            };
            applyAlign();

            // Commit the width change through a ProseMirror transaction.
            // Read the current attrs from the live document (the node from props is the INITIAL
            // snapshot and goes stale after the first setNodeMarkup call).
            const commitWidth = (px: number) => {
                // A mouseup can arrive after the NodeView or editor is destroyed (navigation mid-drag).
                if (disposed || editor.isDestroyed) return;
                if (typeof getPos !== "function") return;
                const pos = getPos();
                if (pos === undefined) return;
                const live = editor.state.doc.nodeAt(pos);
                if (!live) return;
                const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
                    ...live.attrs,
                    width: `${px}px`,
                });
                // After setNodeMarkup on a block atom, ProseMirror tries to map the existing
                // TextSelection and can land on the doc root (which has no inline content) → a warning.
                // Set a NodeSelection on this atom so the selection stays valid.
                try {
                    tr.setSelection(NodeSelection.create(tr.doc, pos));
                } catch (_) {}
                editor.view.dispatch(tr);
            };
            dom.className = "encfile-node";

            const img = document.createElement("img");
            img.className = "max-w-full rounded-md";
            // The alt is deliberately empty until src is set (resolveUrl is async — a decryption/worker
            // round trip): an <img> with no src but with alt="me.jpg" would be shown by the browser as
            // fallback text until the image arrives. The real alt is set below, together with src.
            img.alt = "";
            img.style.margin = "0"; // the margin is on the dom wrapper instead
            // draggable=false prevents the browser's native HTML drag of the <img> element.
            // ProseMirror listens for dragstart on the parent dom wrapper (which TipTap marks
            // draggable="true" for an atom node) and handles moving the node itself.
            img.draggable = false;
            dom.appendChild(img);

            const overlaySlot = new OverlaySlot(dom);
            let fileChip: HTMLElement | null = null;
            // The remove button that appears on hover for media nodes (video/audio). The toolbar
            // cannot be shown, because the mousedown stopPropagation on <video>/<audio> prevents
            // ProseMirror's selectNode() from firing.
            let mediaRemoveBtn: HTMLElement | null = null;
            let unsubscribe: (() => void) | null = null;
            let currentMime: string | null = node.attrs.mime ?? null;
            // Track the ProseMirror selection so the resize handle appears even when the image loads
            // asynchronously after selectNode().
            let isSelected = false;

            // A download click on the chip → it bubbles up to the NoteFileEvents handler.
            const dispatchDownload = (fileId: string) => {
                dom.dispatchEvent(
                    new CustomEvent(APP_EVENTS.encfileDownload, {
                        detail: { fileId },
                        bubbles: true,
                    }),
                );
            };

            const clearFileChip = () => {
                fileChip?.remove();
                fileChip = null;
                mediaRemoveBtn?.remove();
                mediaRemoveBtn = null;
            };

            // Show and hide mediaRemoveBtn on hover over the container (once, not inside load()).
            dom.addEventListener("mouseenter", () => {
                if (mediaRemoveBtn) {
                    (mediaRemoveBtn as HTMLElement).style.opacity = "1";
                    (mediaRemoveBtn as HTMLElement).style.pointerEvents = "auto";
                }
            });
            dom.addEventListener("mouseleave", () => {
                if (mediaRemoveBtn) {
                    (mediaRemoveBtn as HTMLElement).style.opacity = "0";
                    (mediaRemoveBtn as HTMLElement).style.pointerEvents = "none";
                }
            });

            const resize = new ResizeController({
                img,
                editable: editor.isEditable,
                onCommit: commitWidth,
            });
            dom.appendChild(resize.handle);

            const showImg = (visible: boolean) => {
                img.style.display = visible ? "" : "none";
                resize.setVisible(visible);
            };

            // ── Anti-CLS ─────────────────────────────────────────────────────────────────────
            // Decrypting an image is async; with no space reserved, the `<img>` is 0 px tall and
            // everything below jumps once the image arrives. If the node carries intrinsic dimensions
            // (`data-w`/`data-h`), we know the ratio SYNCHRONOUSLY — with nothing decrypted — and
            // it reserves the space at once. `max-w-full` still scales over-wide images, and
            // `aspect-ratio` keeps the height proportional, so the reserved space equals the final
            // one. This is the ONLY place that decides an <img>'s width and ratio. `update()` calls it
            // rather than touching the style itself — otherwise syncing the display width would wipe
            // the reserved space.
            const reserveSpace = () => {
                const iw = Number(node.attrs.w);
                const ih = Number(node.attrs.h);
                const hasDims = Number.isFinite(iw) && Number.isFinite(ih) && iw > 0 && ih > 0;

                // Mirror into the DOM: without this the attributes live only in the ProseMirror
                // document, so the reserved space can neither be inspected nor debugged on the live
                // element.
                if (hasDims) {
                    img.setAttribute("data-w", String(iw));
                    img.setAttribute("data-h", String(ih));
                    img.style.aspectRatio = `${iw} / ${ih}`;
                } else {
                    img.removeAttribute("data-w");
                    img.removeAttribute("data-h");
                    img.style.removeProperty("aspect-ratio");
                }

                // The display width: a user resize wins; otherwise the intrinsic width (with
                // `max-w-full` still scaling over-wide images, and aspect-ratio keeping the height
                // proportional).
                const displayWidth = node.attrs.width as string | null;
                if (displayWidth) img.style.width = displayWidth;
                else if (hasDims) img.style.width = `${iw}px`;
                else img.style.removeProperty("width");
            };

            // A self-heal for content created before nodes carried intrinsic dimensions: once the
            // image really arrives, write its dimensions into the node so the next render — and
            // every other device — reserves the space. Once per NodeView instance; otherwise every
            // re-render would dirty the note.
            let dimsPersisted = false;
            const persistIntrinsicDims = () => {
                if (dimsPersisted || disposed || editor.isDestroyed) return;
                const iw = img.naturalWidth;
                const ih = img.naturalHeight;
                if (!iw || !ih) return;
                if (Number(node.attrs.w) === iw && Number(node.attrs.h) === ih) {
                    dimsPersisted = true;
                    return;
                }
                if (typeof getPos !== "function") return;
                const pos = getPos();
                if (pos === undefined) return;
                const live = editor.state.doc.nodeAt(pos);
                if (!live) return;
                dimsPersisted = true;
                const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
                    ...live.attrs,
                    w: iw,
                    h: ih,
                });
                // Do not move the selection — this is a background self-heal, not a user action.
                tr.setMeta("addToHistory", false);
                editor.view.dispatch(tr);
            };
            reserveSpace();
            let currentUrl: string | null = null;
            let currentOwned = false; // true = our own object URL (revoke it)
            // true ONLY when resolveUrl really took a blob-cache ref for currentFileId. Do not derive
            // it from `!currentOwned` — the stream/chip/deleted branches hold no ref, so a release
            // would decrement another consumer's ref and revoke the URL out from under its live image
            // (the blob cache's ref-count model).
            let currentAcquired = false;
            let currentFileId: string | null = null;
            let disposed = false;
            // Registered after `disposed`, because `persistIntrinsicDims` reads it (the self-heal above).
            img.addEventListener("load", persistIntrinsicDims);
            let isDeleted = false;
            // true ONLY when the NodeView really rendered an <img> with a blob: URL (a raster).
            // It must NOT mean "has any URL at all" — a streamed video has a currentUrl, but Crop must
            // stay off.
            let renderedAsImage = false;
            // Every load() gets a unique seq — an async resolveUrl catch/then must not
            // overwrite a newer render when an old (trashed, say) promise settles after a restore.
            let loadSeq = 0;
            // The last name resolveUrl really returned for currentFileId. update() uses it to tell
            // "the alt changed through our own self-heal transaction" (already equal to this name,
            // only mirrored) from "the alt arrived from elsewhere and does not match the live name" (a
            // history restore bringing back an old alt from a snapshot for the same fileId — an
            // embed is a live reference and must not show the old name).
            let lastResolvedName: string | null = null;

            const revoke = () => {
                if (currentUrl && currentOwned) {
                    URL.revokeObjectURL(currentUrl);
                } else if (currentAcquired && currentFileId) {
                    const acquiredId = currentFileId;
                    void import("$lib/modules/files/blob-cache").then((m) => m.release(acquiredId));
                }
                currentUrl = null;
                currentOwned = false;
                currentAcquired = false;
                renderedAsImage = false;
            };

            // The live upload progress and retry/abort overlay for a still-pending (`local:`) reference.
            const renderOverlay = (localId: string) => {
                overlaySlot.render(
                    makeUploadOverlay(getUploadState(localId), {
                        onRetry: () => void retryUpload(editor, localId),
                        onAbort: () => void abortPendingUpload(editor, localId),
                    }),
                );
            };

            // The toolbar appears when the node holds a NodeSelection (real files only; a `local:` one
            // has the upload overlay instead). It uses ProseMirror's native selectNode/deselectNode
            // hooks, which avoids global listeners and the blur-steals-focus bug (a mousedown on a
            // toolbar button takes the focus off the editor, fires the editor's "blur" and clears the
            // toolbar before the "click" registers).
            const toolbar = new ToolbarController(dom);
            // Re-sync the toolbar with the current async state. Needed because selectNode() can fire
            // while the node is still `local:` (an upload in progress) or before the decryption
            // resolves — in both cases the toolbar has to (re)appear once load() finishes.
            // Crop ONLY for a rendered raster image (`renderedAsImage`), never for a video stream or a chip.
            const syncToolbar = () => {
                toolbar.clear();
                if (
                    isSelected &&
                    editor.isEditable &&
                    currentFileId &&
                    !currentFileId.startsWith(LOCAL_PREFIX) &&
                    !node.attrs.error
                ) {
                    toolbar.show(currentFileId, renderedAsImage, isDeleted);
                }
            };

            // When a replace or crop bumps the file's content, decrypt again for the new image.
            let unsubInvalidate: (() => void) | null = null;
            const subscribeInvalidate = (fileId: string) => {
                unsubInvalidate?.();
                unsubInvalidate = null;
                if (fileId.startsWith(LOCAL_PREFIX)) return;
                unsubInvalidate = onFileInvalidated(fileId, () => {
                    if (!disposed && currentFileId === fileId) load(fileId);
                });
            };

            const load = (fileId: string | null, mime?: string | null) => {
                const seq = ++loadSeq;
                revoke();
                renderedAsImage = false;
                if (unsubscribe) {
                    unsubscribe();
                    unsubscribe = null;
                }
                currentFileId = fileId;
                isDeleted = false;
                if (mime !== undefined) currentMime = mime;
                // E2E + devtools: a stable selector on the wrapper (the img in the NodeView does not always carry the attribute).
                if (fileId) dom.setAttribute("data-file-id", fileId);
                else dom.removeAttribute("data-file-id");
                overlaySlot.clear();
                toolbar.clear();
                clearFileChip();
                showImg(true);
                if (fileId && !fileId.startsWith(LOCAL_PREFIX)) subscribeInvalidate(fileId);

                // An error node: inserted straight away with no fileId (the >50MB drop).
                if (!fileId && node.attrs.error) {
                    showImg(false);
                    fileChip = makeFileChip(node.attrs.alt || "File", {
                        mime: currentMime,
                        errorMsg: node.attrs.error as string,
                    });
                    dom.appendChild(fileChip);
                    return;
                }

                // A pending non-image: a block-style card with an inline progress bar, plus retry/abort on error.
                if (
                    fileId?.startsWith(LOCAL_PREFIX) &&
                    currentMime &&
                    !isRasterImageMime(currentMime)
                ) {
                    showImg(false);
                    const localId = fileId.slice(LOCAL_PREFIX.length);
                    const chip = makePendingFileChip(node.attrs.alt || "File", {
                        onRetry: () => void retryUpload(editor, localId),
                        onAbort: () => void abortPendingUpload(editor, localId),
                    });
                    fileChip = chip.el;
                    dom.appendChild(fileChip);

                    chip.update(getUploadState(localId));
                    unsubscribe = subscribeUpload(localId, () => {
                        if (!disposed) chip.update(getUploadState(localId));
                    });
                    return;
                }

                if (!fileId) {
                    img.removeAttribute("src");
                    return;
                }

                // Pending image: a progress overlay over the image placeholder.
                if (fileId.startsWith(LOCAL_PREFIX)) {
                    const localId = fileId.slice(LOCAL_PREFIX.length);
                    renderOverlay(localId);
                    unsubscribe = subscribeUpload(localId, () => {
                        if (!disposed) renderOverlay(localId);
                    });
                }

                resolveUrl(fileId)
                    .then(({ url, owned, acquired, name, stream }) => {
                        // A newer load() (or a destroy) overtook us — discard what we just resolved.
                        if (disposed || seq !== loadSeq || currentFileId !== fileId) {
                            if (url && owned) URL.revokeObjectURL(url);
                            // Release ONLY if this resolve really took a ref (see `acquired`).
                            else if (acquired) {
                                void import("$lib/modules/files/blob-cache").then((m) =>
                                    m.release(fileId),
                                );
                            }
                            return;
                        }
                        currentUrl = url;
                        currentOwned = owned;
                        currentAcquired = acquired === true;
                        renderedAsImage = false;

                        if (name) lastResolvedName = name;
                        const displayName = name || node.attrs.alt || "File";

                        // If the real name differs from the node's alt attribute, update it in the editor
                        if (
                            name &&
                            name !== node.attrs.alt &&
                            editor.isEditable &&
                            typeof getPos === "function"
                        ) {
                            const pos = getPos();
                            if (pos !== undefined) {
                                const live = editor.state.doc.nodeAt(pos);
                                if (live && live.attrs.alt !== name) {
                                    const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
                                        ...live.attrs,
                                        alt: name,
                                    });
                                    // Stop the TextSelection landing on the doc root after setNodeMarkup
                                    // on a block atom (there is no inline content → a PM warning).
                                    try {
                                        tr.setSelection(NodeSelection.create(tr.doc, pos));
                                    } catch (_) {}
                                    editor.view.dispatch(tr);
                                }
                            }
                        }

                        if (stream && url) {
                            showImg(false);
                            clearFileChip();
                            renderedAsImage = false;
                            // Prefer the payload/node mime; an empty attr + a stream URL → assume video
                            // (an audio stream still works with a currentMime of audio/*).
                            const isVideo = currentMime ? currentMime.startsWith("video/") : true;
                            const mediaEl = document.createElement(
                                isVideo ? "video" : "audio",
                            ) as HTMLMediaElement;
                            mediaEl.controls = true;
                            mediaEl.preload = "metadata";
                            mediaEl.className = "max-w-full rounded-md shadow-sm";
                            if (isVideo) {
                                mediaEl.style.background = "#000";
                                mediaEl.style.maxHeight = "70vh";
                            } else {
                                mediaEl.style.width = "300px";
                                mediaEl.style.height = "54px";
                            }
                            // Important: do not let TipTap consume clicks on the controls
                            mediaEl.addEventListener("mousedown", (e) => e.stopPropagation());

                            let mediaRetries = 0;
                            const fallBackToChip = (reason: "sw" | "codec") => {
                                if (disposed || seq !== loadSeq || currentFileId !== fileId) return;
                                clearFileChip();
                                renderedAsImage = false;
                                // The file itself is fine (upload and decrypt work) — the browser cannot
                                // decode the stream (a common case: HEVC, MPEG-4 Part 2, an odd torrent
                                // re-encode).
                                fileChip = makeFileChip(displayName, {
                                    mime: currentMime,
                                    downloadFileId: fileId,
                                    onDownload: dispatchDownload,
                                    subtitle:
                                        reason === "sw"
                                            ? "Playback unavailable — try refresh, or download"
                                            : "Can't play this codec in the browser — download instead",
                                });
                                dom.appendChild(fileChip);
                                // If the node was selected while the stream URL "looked like" a
                                // currentUrl, take Crop off the toolbar (Info/Remove only).
                                syncToolbar();
                            };
                            // canPlayType said "maybe" but the decode/stream fails → one retry (an SW
                            // claim race, a cold chunk 0 off the network), then a chip with a clear message.
                            mediaEl.addEventListener("error", () => {
                                if (disposed || seq !== loadSeq || currentFileId !== fileId) return;
                                if (mediaRetries < 1) {
                                    mediaRetries++;
                                    void import("$lib/core/streaming/sw-bridge")
                                        .then(({ ensureStreamServiceWorker }) =>
                                            ensureStreamServiceWorker(),
                                        )
                                        .then((ok) => {
                                            if (
                                                disposed ||
                                                seq !== loadSeq ||
                                                currentFileId !== fileId
                                            ) {
                                                return;
                                            }
                                            if (!ok) {
                                                fallBackToChip("sw");
                                                return;
                                            }
                                            // Bust any failed partial response in the HTTP cache.
                                            mediaEl.src = `${url}${url.includes("?") ? "&" : "?"}r=${mediaRetries}`;
                                            mediaEl.load();
                                        })
                                        .catch(() => fallBackToChip("sw"));
                                    return;
                                }
                                fallBackToChip("codec");
                            });
                            mediaEl.src = url;
                            dom.appendChild(mediaEl);
                            fileChip = mediaEl;

                            // A persistent remove button — hover-only, hidden to begin with.
                            // The toolbar cannot be shown, because a mousedown on <video>/<audio> blocks
                            // propagation → ProseMirror's selectNode never fires.
                            if (editor.isEditable) {
                                const btn = document.createElement("button");
                                btn.type = "button";
                                btn.contentEditable = "false";
                                btn.className =
                                    "absolute top-1.5 right-1.5 z-20 text-xs px-2 py-0.5 rounded text-white bg-black/70 hover:bg-red-600 transition";
                                btn.style.opacity = "0";
                                btn.style.pointerEvents = "none";
                                btn.textContent = "Remove";
                                btn.addEventListener("mousedown", (e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                });
                                btn.addEventListener("click", () => {
                                    dom.dispatchEvent(
                                        new CustomEvent(APP_EVENTS.encfileDelete, {
                                            detail: { fileId },
                                            bubbles: true,
                                        }),
                                    );
                                });
                                dom.appendChild(btn);
                                mediaRemoveBtn = btn;
                            }
                        } else if (url) {
                            // A blob URL for the raster preview — the only case where Crop makes sense.
                            renderedAsImage = true;
                            img.src = url;
                            img.alt = displayName;
                            // Apply the stored width.
                            const w = editor.state.doc.nodeAt(
                                typeof getPos === "function" ? (getPos() ?? -1) : -1,
                            )?.attrs.width;
                            if (w) img.style.width = w;
                            // The node was clicked before the decryption finished — show the handle now.
                        } else {
                            // A download-only file (non-image, SVG, PDF…) — show a chip
                            showImg(false);
                            clearFileChip();
                            renderedAsImage = false;
                            fileChip = makeFileChip(displayName, {
                                mime: currentMime,
                                downloadFileId: fileId,
                                onDownload: dispatchDownload,
                            });
                            dom.appendChild(fileChip);
                        }
                        syncToolbar();
                    })
                    .catch((err: unknown) => {
                        if (disposed || seq !== loadSeq || currentFileId !== fileId) return;
                        if ((err as { name?: string })?.name === "FileDeletedError") {
                            isDeleted = true;
                            // KEEP the node — do not remove it — and show a placeholder, in both
                            // editable and read-only mode. That preserves the embed, so a restore
                            // (invalidateFile → a re-render) puts the file back in its place in the
                            // note. The node is already subscribed to onFileInvalidated
                            // (subscribeInvalidate in load()).
                            showImg(false);
                            clearFileChip();
                            const reason = (err as { reason?: string }).reason;
                            const isImg = isRasterImageMime(node.attrs.mime as string | null);
                            const errorMsg =
                                reason === "trashed"
                                    ? isImg
                                        ? "Image in trash"
                                        : "File in trash"
                                    : isImg
                                      ? "Image deleted"
                                      : "File deleted";
                            const isTrashed = reason === "trashed";
                            fileChip = makeFileChip(node.attrs.alt || "File", {
                                mime: currentMime,
                                deletedMsg: errorMsg,
                                // TRASHED → Restore: the file can come back, so no Remove is offered.
                                // NoteFileEvents listens for `encfile:restore` and calls FileService.restore.
                                onRestore: isTrashed
                                    ? () => {
                                          dom.dispatchEvent(
                                              new CustomEvent(APP_EVENTS.encfileRestore, {
                                                  detail: { fileId: currentFileId },
                                                  bubbles: true,
                                              }),
                                          );
                                      }
                                    : undefined,
                                // DELETED → Remove the reference only (what is permanently gone is not resurrected).
                                onRemove: isTrashed
                                    ? undefined
                                    : () => {
                                          dom.dispatchEvent(
                                              new CustomEvent(APP_EVENTS.encfileDelete, {
                                                  detail: { fileId: currentFileId },
                                                  bubbles: true,
                                              }),
                                          );
                                      },
                            });
                            dom.appendChild(fileChip);
                        } else {
                            img.alt = "⚠ could not load file";
                        }
                        syncToolbar();
                    });
            };

            load(node.attrs.fileId);

            return {
                dom,
                selectNode() {
                    isSelected = true;
                    syncToolbar();
                },
                deselectNode() {
                    isSelected = false;
                    toolbar.clear();
                },
                update(updatedNode) {
                    if (updatedNode.type.name !== "encFile") return false;
                    // Refresh the snapshot first — the load() below reads node.attrs (alt/error/mime).
                    node = updatedNode;
                    const newId = updatedNode.attrs.fileId;
                    const newMime = updatedNode.attrs.mime ?? null;
                    const newAlt = updatedNode.attrs.alt || "File";
                    if (newId !== currentFileId || newMime !== currentMime) {
                        load(newId, newMime);
                    } else if (lastResolvedName && newAlt !== lastResolvedName) {
                        // An alt arriving from elsewhere does not match the last live name (a history
                        // restore bringing back an old alt from a snapshot taken before a rename) — a
                        // file embed is a live reference, so force a re-resolve instead of
                        // mirroring a stale name.
                        load(newId, newMime);
                    } else {
                        // Sync the alt attribute if it changed (after a committed rename transaction,
                        // where `newAlt` already equals `lastResolvedName` — this is only a mirror into
                        // the DOM). Only while src is already set — otherwise the same
                        // flash-of-fallback-text problem returns (see the img.alt = "" comment above)
                        // while the image is still resolving.
                        if (currentUrl) img.alt = newAlt;
                        if (fileChip) {
                            // A stable hook — the chip's Tailwind classes change with the design.
                            const nameEl = fileChip.querySelector(`[${CHIP_NAME_ATTR}]`);
                            if (nameEl) nameEl.textContent = newAlt;
                        }
                    }
                    // Syncing the width from a resize commit plus the space reservation. It
                    // goes through `reserveSpace` so the two do not tread on each other: an earlier
                    // `removeProperty("width")` on a node with no user width would wipe the intrinsic
                    // width and bring back CLS.
                    reserveSpace();
                    applyAlign();
                    return true;
                },
                destroy() {
                    disposed = true;
                    if (unsubscribe) {
                        unsubscribe();
                        unsubscribe = null;
                    }
                    unsubInvalidate?.();
                    overlaySlot.clear();
                    toolbar.clear();
                    clearFileChip();
                    revoke();
                },
            };
        };
    },
});
