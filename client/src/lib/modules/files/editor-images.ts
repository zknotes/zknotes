// Orchestrates files dropped or pasted into the note editor.
//
// Rules (the limit is the per-user `users.max_file_size`, cached in ./limits):
//   - Image ≤ 10MB          → silent downscale + upload (no interruption)
//   - Image > 10MB or any non-image ≤ limit → dispatch `encfile:confirmNeeded` (note page shows dialog)
//   - Any file > limit                      → insert inline error node, no upload
//   - Limit not known yet (offline cold start) → no refusal by size; the server decides

import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { uuidv7 } from "uuidv7";
import { APP_EVENTS } from "$lib/core/constants/events";
import { getDB, type PendingUpload } from "$lib/core/db";
import { devLog, devWarn } from "$lib/core/utils/dev-log";
import { downscaleImage } from "./downscale";
import { isRasterImageMime } from "./sniff";
import { getMaxFileSizeMB, isOverFileSizeLimit } from "./limits";
import {
    getOpfsCapability,
    isStagingComplete,
    LEGACY_BLOB_MAX_BYTES,
    shouldWarnNoResume,
    stageFileToOpfs,
} from "./opfs-staging";
import { LOCAL_PREFIX } from "./refs";
import { orphanMayResume, reconcileSyncingUploads, startUpload } from "./upload-manager";
import { createPendingUploadBase, normalizePending, shouldResumeOnStartup } from "./upload-state";

const CONFIRM_THRESHOLD = 10 * 1024 * 1024; // 10 MB

/**
 * An inserted file is an undo step of its own: an edit right after it — a removal within the
 * history's grouping delay, say — must not join it, or undoing that edit takes the insertion back
 * too.
 */
function closeUndoStep(editor: Editor): void {
    if (!editor.isDestroyed) editor.view.dispatch(closeHistory(editor.state.tr));
}

export function insertEncFile(editor: Editor, fileId: string, alt: string, mime?: string) {
    const ok = editor
        .chain()
        .focus()
        .insertContent({ type: "encFile", attrs: { fileId, alt, mime: mime ?? null } })
        .run();
    if (!ok) devWarn("upload", "insertEncFile failed for fileId:", fileId);
    else {
        closeUndoStep(editor);
        devLog("upload", "insertEncFile ok →", fileId);
    }
}

async function persistPendingPatch(localId: string, patch: Partial<PendingUpload>): Promise<void> {
    const db = await getDB();
    const existing = await db.get("pending-uploads", localId);
    if (!existing) return;
    await db.put("pending-uploads", {
        ...existing,
        ...patch,
        last_activity_at: Date.now(),
    });
}

/**
 * Phase 1 of the two-phase upload: a downscale (for an image), then OPFS staging or an IDB blob.
 * Returns a PendingUpload record ready for the node to be inserted.
 */
export async function preparePendingUpload(
    file: File,
    noteId: string,
    parentId: string | null,
    opts?: { localId?: string },
): Promise<PendingUpload> {
    const isImage = isRasterImageMime(file.type);
    const processed = isImage ? await downscaleImage(file) : file;
    // Promote passes along the sync-assigned localId so it matches data-file-id in the HTML.
    const localId = opts?.localId ?? uuidv7();
    const plainSize = processed instanceof File ? processed.size : file.size;
    const capability = await getOpfsCapability();

    const pending: PendingUpload = {
        ...createPendingUploadBase(
            localId,
            {
                name: processed instanceof File ? processed.name : file.name,
                type: processed instanceof File ? processed.type : file.type,
                size: plainSize,
            },
            noteId,
            parentId ?? noteId,
        ),
        staging_id: localId,
        staging_bytes_written: 0,
    };

    const db = await getDB();
    await db.put("pending-uploads", pending);

    if (capability !== "none") {
        pending.storage_mode = "opfs";
        try {
            await stageFileToOpfs(processed, localId, {
                onBlockWritten: async (written) => {
                    pending.staging_bytes_written = written;
                    await persistPendingPatch(localId, { staging_bytes_written: written });
                },
            });
        } catch (e) {
            const { deleteStaging } = await import("./opfs-staging");
            await deleteStaging(localId).catch(() => {});
            await persistPendingPatch(localId, {
                phase: "failed_recoverable",
                last_error: e instanceof Error ? e.message : "Staging failed",
            });
            throw e;
        }
        pending.staging_bytes_written = plainSize;
        await persistPendingPatch(localId, {
            staging_bytes_written: plainSize,
            storage_mode: "opfs",
        });
        devLog("upload", "OPFS staged →", localId, plainSize);
        return pending;
    }

    if (plainSize <= LEGACY_BLOB_MAX_BYTES) {
        pending.storage_mode = "idb_blob";
        pending.blob = processed;
        await db.put("pending-uploads", { ...pending, blob: processed, storage_mode: "idb_blob" });
        devLog("upload", "IDB blob stored →", localId);
        return pending;
    }

    // >500 MB with no OPFS: the upload works within the session, F5 = a restart.
    pending.storage_mode = "ephemeral";
    pending.blob = processed;
    await db.put("pending-uploads", {
        ...pending,
        blob: undefined,
        storage_mode: "ephemeral",
    });
    devLog("upload", "ephemeral (no resume after reload) →", localId);
    return pending;
}

/** True when the caller should warn that a resume after a reload is impossible. */
export function pendingNeedsNoResumeWarning(pending: PendingUpload): boolean {
    return pending.storage_mode === "ephemeral";
}

/**
 * Phase 2: insert the encFile node and start the background upload.
 */
export function insertAndStartUpload(editor: Editor, pending: PendingUpload): void {
    devLog("upload", "inserting node →", pending.local_id);
    insertEncFile(editor, LOCAL_PREFIX + pending.local_id, pending.name, pending.mime);

    if (pendingNeedsNoResumeWarning(pending)) {
        editor.view.dom.dispatchEvent(
            new CustomEvent(APP_EVENTS.encfileNoResume, {
                detail: { name: pending.name },
                bubbles: true,
            }),
        );
    }

    void startUpload(editor, pending);
}

/**
 * Inserts several encFile nodes in one transaction and starts their background uploads.
 */
export function insertAndStartUploads(editor: Editor, pendings: PendingUpload[]): void {
    if (pendings.length === 0) return;

    devLog(
        "upload",
        "inserting batch nodes →",
        pendings.map((p) => p.local_id),
    );

    const content = pendings.map((pending) => ({
        type: "encFile",
        attrs: {
            fileId: LOCAL_PREFIX + pending.local_id,
            alt: pending.name,
            mime: pending.mime ?? null,
        },
    }));

    const ok = editor.chain().focus().insertContent(content).run();
    if (!ok) devWarn("upload", "insertContent failed for batch upload");
    else closeUndoStep(editor);

    for (const pending of pendings) {
        if (pendingNeedsNoResumeWarning(pending)) {
            editor.view.dom.dispatchEvent(
                new CustomEvent(APP_EVENTS.encfileNoResume, {
                    detail: { name: pending.name },
                    bubbles: true,
                }),
            );
        }
        void startUpload(editor, pending);
    }
}

/**
 * The entry point for the editor's paste/drop handlers. It applies the size guards and dispatches
 * either a silent upload (small images) or an `encfile:confirmNeeded` event (large or non-image
 * files).
 */
export async function handleEditorImageFiles(
    editor: Editor,
    files: File[],
    noteId: string,
    parentId: string | null,
): Promise<boolean> {
    if (files.length === 0) return false;
    devLog(
        "upload",
        "handleEditorImageFiles received",
        files.length,
        "file(s):",
        files.map((f) => f.name),
    );

    const toConfirm: File[] = [];
    const silentFiles: File[] = [];

    for (const file of files) {
        if (await isOverFileSizeLimit(file.size)) {
            editor.view.dom.dispatchEvent(
                new CustomEvent(APP_EVENTS.encfileTooLarge, {
                    detail: { name: file.name, maxMB: getMaxFileSizeMB() },
                    bubbles: true,
                }),
            );
            continue;
        }

        const isImage = isRasterImageMime(file.type);

        if (isImage && file.size <= CONFIRM_THRESHOLD) {
            devLog("upload", "silent path →", file.name);
            silentFiles.push(file);
            continue;
        }

        devLog("upload", "confirm path →", file.name);
        toConfirm.push(file);
    }

    if (silentFiles.length > 0) {
        const capability = await getOpfsCapability();
        for (const file of silentFiles) {
            if (shouldWarnNoResume(capability, file.size)) {
                editor.view.dom.dispatchEvent(
                    new CustomEvent(APP_EVENTS.encfileNoResume, {
                        detail: { name: file.name },
                        bubbles: true,
                    }),
                );
            }
        }
        const pendings = await Promise.all(
            silentFiles.map((file) => preparePendingUpload(file, noteId, parentId)),
        );
        insertAndStartUploads(editor, pendings);
    }

    if (toConfirm.length > 0) {
        devLog(
            "upload",
            "dispatching confirmNeeded for",
            toConfirm.length,
            "file(s):",
            toConfirm.map((f) => f.name),
        );
        editor.view.dom.dispatchEvent(
            new CustomEvent(APP_EVENTS.encfileConfirmNeeded, {
                detail: { files: toConfirm, noteId, parentId },
                bubbles: true,
            }),
        );
    }

    return true;
}

/** On the editor's mount, resume the uploads for this note left hanging by a previous reload or crash. */
export async function resumePendingUploads(editor: Editor, noteId: string): Promise<void> {
    const db = await getDB();
    const all = await db.getAll("pending-uploads");
    for (const pending of all) {
        if (pending.note_id !== noteId) continue;
        // The startup resume's own predicate: a terminal row stays put, and a `syncing`
        // row — its file already exists — belongs to the reconciler below, not to a new upload.
        if (!shouldResumeOnStartup(normalizePending(pending).phase)) continue;
        if (pending.storage_mode === "ephemeral") continue;
        if (pending.staging_id && !isStagingComplete(pending) && !pending.blob) continue;
        if (!(await orphanMayResume(pending))) continue;
        void startUpload(editor, pending);
    }
    void reconcileSyncingUploads();
}
