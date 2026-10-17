// The pub/sub for "file content replaced" — it tells the encFile NodeViews to decrypt again even when
// their `data-file-id` attribute has not changed. It mirrors the upload-manager pattern.
//
// BroadcastChannel("zknotes-files"): when one tab invalidates a file, the notification spreads to
// every other open tab. Only the fileId travels through the channel, plus a note id for a move — no
// key material and no plaintext bytes — so the crypto worker's trust boundary stays intact.

import { APP_EVENTS } from "$lib/core/constants/events";
import { createKeyedChannel } from "./keyed-channel";

const channel = createKeyedChannel();

// ── A local-only notify (with no cross-tab broadcast) ───────────────────────────
// The channel's receiver uses it, to avoid a re-broadcast and echo loops.
function notifyLocal(fileId: string): void {
    channel.emit(fileId);
}

type BcMessage =
    | { type: "file-invalidated"; fileId: string }
    | { type: "file-moved"; fileId: string; toNoteId: string }
    | { type: "file-trashed"; fileId: string }
    | { type: "file-restored"; fileId: string; toNoteId: string };

/** The window-level event NoteAutosave reconciles its baseline from (see APP_EVENTS.remoteFileRefsChanged). */
function dispatchRemoteRefsChanged(fileId: string, toNoteId?: string): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
        new CustomEvent(APP_EVENTS.remoteFileRefsChanged, {
            detail: toNoteId ? { fileId, toNoteId } : { fileId },
        }),
    );
}

// ── BroadcastChannel setup ───────────────────────────────────────────────────

let _bc: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
    if (_bc !== null) return _bc;
    if (typeof BroadcastChannel === "undefined") return null;

    _bc = new BroadcastChannel("zknotes-files");

    // When another tab invalidates or moves a file: the local blob cache + the NodeView + (for a move)
    // a silent removal of the embed from the source note's editor. With no re-broadcast (an echo).
    _bc.onmessage = (e: MessageEvent) => {
        const data = (e.data ?? {}) as Partial<BcMessage>;
        if (data.type === "file-invalidated" && typeof data.fileId === "string") {
            void import("./blob-cache").then(({ invalidateSilent }) => {
                invalidateSilent(data.fileId as string);
                notifyLocal(data.fileId as string);
            });
            return;
        }
        if (
            data.type === "file-moved" &&
            typeof data.fileId === "string" &&
            typeof data.toNoteId === "string"
        ) {
            const fileId = data.fileId;
            const toNoteId = data.toNoteId;
            void import("./blob-cache").then(({ invalidateSilent }) => {
                invalidateSilent(fileId);
                notifyLocal(fileId);
            });
            // The destination and owner notes: invalidate their note queries in this tab.
            void import("./files-changed-bus").then(({ emitFilesChanged, emitNotesChanged }) => {
                emitFilesChanged([fileId]);
                emitNotesChanged([toNoteId]);
            });
            // The baseline reconcile FIRST (it records whether the editor was dirty before the node
            // removal below marks it dirty), then the source editors remove the live encFile
            // silently. The destination (toNoteId) is not stripped — NoteAutosave reloads it or
            // appends the embed, depending on whether the user is mid-edit there.
            dispatchRemoteRefsChanged(fileId, toNoteId);
            if (typeof document !== "undefined") {
                document.dispatchEvent(
                    new CustomEvent(APP_EVENTS.encfileDelete, {
                        detail: { fileId, silent: true, toNoteId },
                    }),
                );
            }
            return;
        }
        if (data.type === "file-trashed" && typeof data.fileId === "string") {
            const fileId = data.fileId;
            void import("./blob-cache").then(({ invalidateSilent }) => {
                invalidateSilent(fileId);
                notifyLocal(fileId);
            });
            void import("./files-changed-bus").then(({ emitFilesChanged }) => {
                emitFilesChanged([fileId]);
            });
            // The same order as a move: the baseline reconcile, then a silent node removal in every
            // open editor (the other tab already stripped the embed out of the stored content).
            dispatchRemoteRefsChanged(fileId);
            if (typeof document !== "undefined") {
                document.dispatchEvent(
                    new CustomEvent(APP_EVENTS.encfileDelete, {
                        detail: { fileId, silent: true },
                    }),
                );
            }
            return;
        }
        if (
            data.type === "file-restored" &&
            typeof data.fileId === "string" &&
            typeof data.toNoteId === "string"
        ) {
            const fileId = data.fileId;
            const toNoteId = data.toNoteId;
            void import("./blob-cache").then(({ invalidateSilent }) => {
                invalidateSilent(fileId);
                notifyLocal(fileId);
            });
            void import("./files-changed-bus").then(({ emitFilesChanged, emitNotesChanged }) => {
                emitFilesChanged([fileId]);
                emitNotesChanged([toNoteId]);
            });
            // The owner note got the embed appended in the other tab — nothing to remove here.
            dispatchRemoteRefsChanged(fileId, toNoteId);
        }
    };

    return _bc;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Opens the cross-tab channel so THIS tab receives the other tabs' messages. Before this existed
 * the channel was created lazily by the first `notify*` call — a tab that only ever LISTENED (a
 * note open in the editor, never touching a file itself) had no receiver at all, and none of the
 * cross-tab messages reached it. Called from the files bootstrap (register-bridge) and by the first
 * subscriber.
 */
export function ensureFilesBroadcastChannel(): void {
    getChannel();
}

export function onFileInvalidated(fileId: string, cb: () => void): () => void {
    ensureFilesBroadcastChannel();
    return channel.on(fileId, cb);
}

/**
 * Tell the local NodeViews a file's content has changed, and broadcast the invalidation to
 * every other open tab, so their blob caches and NodeViews refresh too.
 */
export function notifyFileInvalidated(fileId: string): void {
    notifyLocal(fileId);
    // The cross-tab broadcast — the fileId only, never key material or plaintext.
    getChannel()?.postMessage({ type: "file-invalidated", fileId } satisfies BcMessage);
}

/**
 * A multi-tab move: the other tabs remove the embed from their source editors and refresh the note and file queries.
 * It is called from FileService.move, after the local reparent+embed transfer.
 */
export function notifyFileMoved(fileId: string, toNoteId: string): void {
    notifyLocal(fileId);
    getChannel()?.postMessage({ type: "file-moved", fileId, toNoteId } satisfies BcMessage);
}

/**
 * A multi-tab trash: the embed was stripped out of every note's stored content in this tab. The
 * other tabs remove the live node from their editors and reconcile their save baselines, so a note
 * open (and being edited) over there does not turn the strip into a false conflict copy on its next
 * save. It is called from FileService.trash, after the strip.
 */
export function notifyFileTrashed(fileId: string): void {
    getChannel()?.postMessage({ type: "file-trashed", fileId } satisfies BcMessage);
}

/**
 * A multi-tab restore: the embed was appended to the owner note's stored content in this tab. The
 * other tabs refresh that note (or reconcile the baseline of an editor mid-edit on it).
 * It is called from FileService.restore, only when it really appended.
 */
export function notifyFileRestored(fileId: string, toNoteId: string): void {
    getChannel()?.postMessage({ type: "file-restored", fileId, toNoteId } satisfies BcMessage);
}
