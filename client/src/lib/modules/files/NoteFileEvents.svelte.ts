import type { Editor } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Node as ProseNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { APP_EVENTS } from "$lib/core/constants/events";
import { getDB } from "$lib/core/db";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { devLog } from "$lib/core/utils/dev-log";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";
import { FileService } from "./file-service";
import {
    PENDING_TRASH_GRACE_MS,
    pendingTrashManager,
    skipPendingTrashFileIds,
} from "./pending-trash";
import { LOCAL_PREFIX, UPLOAD_REF_META } from "./refs";
import { releaseRemovedUpload } from "./removed-uploads";

/**
 * Whether a transaction that drops a `local:` node is the user removing it — not the
 * upload pipeline re-pointing or dropping it, and not a change kept out of the history, such as a
 * promotion rolled back to its data: image.
 */
function isUserRemovalOfUpload(tr: Transaction): boolean {
    return tr.getMeta(UPLOAD_REF_META) !== true && tr.getMeta("addToHistory") !== false;
}

function encFileIdsInDoc(doc: ProseNode): Set<string> {
    const ids = new Set<string>();
    doc.descendants((node) => {
        if (node.type.name === "encFile" && node.attrs.fileId) {
            ids.add(node.attrs.fileId as string);
        }
    });
    return ids;
}

export class NoteFileEvents {
    confirmQueue = $state<Array<{ file: File; noteId: string; parentId: string | null }>>([]);
    sizeErrorMsg = $state<string | null>(null);
    cropTarget = $state<{ fileId: string; blob: Blob; name: string } | null>(null);
    openInfoFileId = $state<string | null>(null);

    #cropPreparing = false;
    #sizeErrorTimer: ReturnType<typeof setTimeout> | undefined;

    showSizeError(msg: string, durationMs = 3000): void {
        clearTimeout(this.#sizeErrorTimer);
        this.sizeErrorMsg = msg;
        this.#sizeErrorTimer = setTimeout(() => (this.sizeErrorMsg = null), durationMs);
    }

    // Mounts the document-level encfile:* listeners. It returns a cleanup function suitable as an
    // $effect return value. Call it again (through $effect) whenever the editor or currentNoteId
    // changes, so the handlers always reference the latest values.
    mount(
        editor: Editor | undefined,
        currentNoteId: string | undefined,
        isProgrammatic: () => boolean = () => false,
    ): () => void {
        const onDelete = (e: Event) => {
            const detail = (e as CustomEvent).detail as {
                fileId: string;
                silent?: boolean;
                /** A cross-tab move: the destination note — do not strip, force-reload the content. */
                toNoteId?: string;
                /** Set by this handler once the mounted editor has removed the node or nodes. */
                handled?: boolean;
            };
            const { fileId, silent, toNoteId } = detail;
            if (!editor) return;

            // A multi-tab move: this editor is the destination — do not delete the node. Whether the
            // content is reloaded from IDB or the embed appended into a mid-edit doc is NoteAutosave's
            // call (remoteFileRefsChanged): a force reload here used to overwrite the user's unsaved
            // typing in the destination note.
            if (toNoteId && currentNoteId === toNoteId) {
                detail.handled = true;
                return;
            }

            // An explicit delete of an upload aborts it at once (below), with no grace to wait out.
            const skipGrace = silent || fileId.startsWith(LOCAL_PREFIX);
            if (skipGrace) {
                skipPendingTrashFileIds.add(fileId);
            }

            const targets: { pos: number; size: number }[] = [];
            editor.state.doc.descendants((n, pos) => {
                if (n.type.name === "encFile" && n.attrs.fileId === fileId)
                    targets.push({ pos, size: n.nodeSize });
            });

            if (targets.length > 0) {
                const ok = editor
                    .chain()
                    .focus()
                    .command(({ tr }) => {
                        for (const t of targets.reverse()) tr.delete(t.pos, t.pos + t.size);
                        return true;
                    })
                    .run();
                if (ok) detail.handled = true;
            }

            if (targets.length > 0 && !silent && fileId.startsWith(LOCAL_PREFIX)) {
                const localId = fileId.slice(LOCAL_PREFIX.length);
                import("$lib/modules/files/upload-manager").then(({ abortPendingUpload }) => {
                    void abortPendingUpload(editor, localId);
                });
            }

            if (skipGrace) {
                queueMicrotask(() => skipPendingTrashFileIds.delete(fileId));
            }
        };

        const onTransaction = ({ transaction }: { transaction: Transaction }) => {
            if (!editor || !currentNoteId || !transaction.docChanged) return;
            if (isProgrammatic()) return;

            const before = encFileIdsInDoc(transaction.before);
            const after = encFileIdsInDoc(transaction.doc);

            for (const fileId of before) {
                if (after.has(fileId)) continue;
                if (skipPendingTrashFileIds.has(fileId)) continue;
                // An upload still running gets the same grace, then an abort.
                if (fileId.startsWith(LOCAL_PREFIX) && !isUserRemovalOfUpload(transaction))
                    continue;
                pendingTrashManager.schedule(fileId, currentNoteId, editor);
            }

            // An undo or a redo that brings a file back. prosemirror-history marks its transactions
            // under its plugin key, not under the string "history" read here before, so this branch
            // never ran.
            if (isHistoryTransaction(transaction)) {
                for (const fileId of after) {
                    if (before.has(fileId)) continue;
                    const wasPending = pendingTrashManager.isPending(fileId);
                    if (wasPending) pendingTrashManager.cancel(fileId);
                    if (fileId.startsWith(LOCAL_PREFIX)) {
                        restoreRemovedUpload(fileId, editor);
                    } else if (!wasPending) {
                        void autoRestoreIfTrashed(fileId, editor);
                    }
                }
            }
        };

        // An undo brought back a `local:` node removed while it uploaded — the history keeps the
        // node as it was then. If its upload finished meanwhile, the node takes the file's real id,
        // once this transaction is done, and a file the grace already sent to the Trash comes back,
        // as any file does.
        const restoreRemovedUpload = (fileId: string, ed: Editor) => {
            const finished = releaseRemovedUpload(fileId.slice(LOCAL_PREFIX.length));
            if (!finished) return;
            void import("$lib/modules/files/upload-manager").then(({ swapFileId }) => {
                swapFileId(ed, fileId, finished);
            });
            void autoRestoreIfTrashed(finished, ed);
        };

        const autoRestoreIfTrashed = async (fileId: string, ed: Editor) => {
            const db = await getDB();
            const item = await db.get("items", fileId);
            if (!item || FileLifecycle.stateOf(item) !== "TRASHED") return;
            try {
                await FileService.restore(fileId);
                globalToasts.add({
                    variant: "info",
                    message: "File restored from trash.",
                    durationMs: PENDING_TRASH_GRACE_MS,
                    action: {
                        label: "Undo",
                        onClick: () => {
                            void FileService.trash(fileId);
                            ed.commands.undo();
                        },
                    },
                });
            } catch (err) {
                console.warn("Auto-restore failed", err);
            }
        };

        const onRestore = async (e: Event) => {
            const { fileId } = (e as CustomEvent).detail as { fileId: string };
            try {
                await FileService.restore(fileId);
            } catch (err) {
                console.warn("Restore failed", err);
            }
        };

        const onConfirmNeeded = (e: Event) => {
            const { files, noteId, parentId } = (e as CustomEvent).detail as {
                files: File[];
                noteId: string;
                parentId: string | null;
            };
            devLog(
                "upload",
                "onConfirmNeeded: received",
                files.length,
                "file(s), queue before:",
                this.confirmQueue.length,
            );
            this.confirmQueue.push(...files.map((file) => ({ file, noteId, parentId })));
            devLog("upload", "onConfirmNeeded: queue after:", this.confirmQueue.length);
        };

        const onDownload = async (e: Event) => {
            const { fileId } = (e as CustomEvent).detail as { fileId: string };
            // A persistent toast for as long as a multi-GB stream lasts (the old saveFile used to OOM
            // silently, or work for a long time with no UI → "you click and nothing happens").
            let toastId = globalToasts.add({
                message: "Downloading…",
                variant: "info",
                durationMs: 0,
            });
            let lastPctShown = -1;
            try {
                const { saveFile, DownloadCancelledError } = await import(
                    "$lib/modules/files/download"
                );
                await saveFile(fileId, (p) => {
                    if (p.totalChunks <= 0) return;
                    const pct = Math.min(
                        100,
                        Math.round(((p.chunkIndex + 1) / p.totalChunks) * 100),
                    );
                    // A throttle: refresh the toast about every 5%, rather than spamming it 400 times.
                    if (pct < 100 && pct - lastPctShown < 5) return;
                    lastPctShown = pct;
                    globalToasts.remove(toastId);
                    toastId = globalToasts.add({
                        message: `Downloading… ${pct}%`,
                        variant: "info",
                        durationMs: 0,
                    });
                });
                globalToasts.remove(toastId);
                globalToasts.add({
                    message: "Download complete",
                    variant: "success",
                    durationMs: 4000,
                });
            } catch (err) {
                globalToasts.remove(toastId);
                if (err instanceof Error && err.name === "DownloadCancelledError") return;
                console.warn("Editor file download failed", err);
                globalToasts.add({
                    message: err instanceof Error ? err.message : "Download failed",
                    variant: "error",
                    durationMs: 8000,
                });
            }
        };

        const onTooLarge = (e: Event) => {
            const { name, maxMB } = (e as CustomEvent).detail as { name: string; maxMB: number };
            clearTimeout(this.#sizeErrorTimer);
            this.sizeErrorMsg = `"${name}" is too large — max ${maxMB} MB`;
            this.#sizeErrorTimer = setTimeout(() => (this.sizeErrorMsg = null), 5000);
        };

        const onNoResume = (e: Event) => {
            const { name } = (e as CustomEvent).detail as { name: string };
            this.showSizeError(
                `"${name}" will upload now, but cannot resume after reload (browser storage unavailable)`,
                8000,
            );
        };

        const onInfo = (e: Event) => {
            const { fileId } = (e as CustomEvent).detail as { fileId: string };
            this.openInfoFileId = fileId;
        };

        const onCropRequest = async (e: Event) => {
            const { fileId } = (e as CustomEvent).detail as { fileId: string };
            if (this.#cropPreparing) return;
            this.#cropPreparing = true;
            try {
                const { decryptFile } = await import("$lib/modules/files/download");
                const result = await decryptFile(fileId);
                if (result.render !== "raster") return;
                this.cropTarget = {
                    fileId,
                    blob: new Blob([result.bytes as BlobPart], { type: result.blobMime }),
                    name: result.name || "image",
                };
            } catch (err) {
                console.warn("Crop open failed", err);
            } finally {
                this.#cropPreparing = false;
            }
        };

        if (editor) {
            editor.on("transaction", onTransaction);
        }

        document.addEventListener(APP_EVENTS.encfileDelete, onDelete);
        document.addEventListener(APP_EVENTS.encfileRestore, onRestore);
        document.addEventListener(APP_EVENTS.encfileConfirmNeeded, onConfirmNeeded);
        document.addEventListener(APP_EVENTS.encfileDownload, onDownload);
        document.addEventListener(APP_EVENTS.encfileTooLarge, onTooLarge);
        document.addEventListener(APP_EVENTS.encfileNoResume, onNoResume);
        document.addEventListener(APP_EVENTS.encfileCropRequest, onCropRequest);
        document.addEventListener(APP_EVENTS.encfileInfo, onInfo);

        return () => {
            if (editor) {
                editor.off("transaction", onTransaction);
            }
            document.removeEventListener(APP_EVENTS.encfileDelete, onDelete);
            document.removeEventListener(APP_EVENTS.encfileRestore, onRestore);
            document.removeEventListener(APP_EVENTS.encfileConfirmNeeded, onConfirmNeeded);
            document.removeEventListener(APP_EVENTS.encfileDownload, onDownload);
            document.removeEventListener(APP_EVENTS.encfileTooLarge, onTooLarge);
            document.removeEventListener(APP_EVENTS.encfileNoResume, onNoResume);
            document.removeEventListener(APP_EVENTS.encfileCropRequest, onCropRequest);
            document.removeEventListener(APP_EVENTS.encfileInfo, onInfo);
            clearTimeout(this.#sizeErrorTimer);
        };
    }

    async handleCropResult(
        blob: Blob,
        _editor: Editor,
        _currentNoteId: string | undefined,
    ): Promise<void> {
        const t = this.cropTarget;
        this.cropTarget = null;
        if (!t) return;
        try {
            const croppedFile = new File([blob], t.name, { type: blob.type || "image/png" });
            await FileService.crop(t.fileId, croppedFile);
        } catch (err) {
            console.warn("Crop save failed", err);
        }
    }
}
