// Tracks in-editor image uploads so a placeholder encFile node can show live progress and offer
// Retry / Abort. One module owns the state, keyed by the pending blob's `local_id`; a NodeView
// subscribes to its own id. On success the node's reference is swapped from `local:<id>` to the
// real fileItemId and the pending row is discarded; on a user Abort the session is aborted and the
// node is removed.

import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { FILE_LIMITS } from "@zknotes/shared";
import { ApiError } from "$lib/core/api/client";
import { APP_EVENTS } from "$lib/core/constants/events";
import { getDB, type LocalItem, type PendingUpload } from "$lib/core/db";
import { CHUNK_SET_NOT_COMMITTED_ERROR } from "$lib/core/sync";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";
import { swapFileRefInNoteContent } from "./cleanup";
import { emitFilesChanged, emitNotesChanged } from "./files-changed-bus";
import { createKeyedChannel } from "./keyed-channel";
import { deleteStaging } from "./opfs-staging";
import { LOCAL_PREFIX, UPLOAD_REF_META } from "./refs";
import { forgetAbandonedUpload, placeFinishedUpload } from "./removed-uploads";
import {
    replaceFileContent,
    resumeUpload,
    startNewUpload,
    type UploadOptions,
    type UploadProgress,
} from "./upload";
import { classifyUploadError, UploadPipelineError, uploadErrorMessage } from "./upload-errors";
import { PAUSED_HEARTBEAT_MS, pingOrExpire } from "./upload-heartbeat";
import { acquireUploadLock, isLockHeldByOtherTab, releaseUploadLock } from "./upload-lock";
import {
    abortActiveUploadSessions,
    cleanupLocalPendingRow,
    sweepStalePendingUploads,
} from "./upload-session-cleanup";
import { uploadSourceFromFile, uploadSourceFromPending } from "./upload-source";
import {
    continuesSession,
    isActiveUploadPhase,
    normalizePending,
    ownerNoteState,
    shouldResumeOnStartup,
    type UploadPhase,
} from "./upload-state";
import { initUploadVisibilityListener } from "./upload-visibility";

export interface UploadState {
    status: "uploading" | "failed" | "locked_elsewhere";
    phase: UploadProgress["phase"];
    chunkIndex: number;
    totalChunks: number;
    chunkPct?: number;
    error?: string;
    /** The display name for the sync panel (editor uploads have none — they are shown through the node). */
    name?: string;
}

const states = new Map<string, UploadState>();
const controllers = new Map<string, AbortController>();
/** Uploads whose owner note is known not to store their `local:` ref any more — see repointStoredNote. */
const noteRepointed = new Set<string>();
const stateChannel = createKeyedChannel();

let activeUploads = 0;
let pendingUnloadGuard = false;
let hardeningInitialized = false;
const uploadQueue: (() => Promise<void>)[] = [];

/** How often the `syncing` rows are reconciled against the item state (a cheap `getAll` on a store that is usually empty). */
const SYNCING_RECONCILE_MS = 60_000;

function ensureUploadHardening(): void {
    initUploadVisibilityListener();
    if (hardeningInitialized) return;
    hardeningInitialized = true;
    setInterval(() => void pingPausedUploads(), PAUSED_HEARTBEAT_MS);
    setInterval(() => void reconcileSyncingUploads(), SYNCING_RECONCILE_MS);
    if (typeof window !== "undefined") {
        // An upload started offline fails on `POST /uploads` and used to sit as "failed" until a
        // reload or a manual Retry — the sync engine's `online` handler drains notes, not uploads.
        window.addEventListener("online", () => {
            void resumeAllPendingUploads({ includeFailed: true });
        });
        // A push acknowledgement (foreground) or any local item change — the moment a `syncing`
        // row may be released.
        let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
        window.addEventListener(APP_EVENTS.vaultItemsChanged, () => {
            clearTimeout(reconcileTimer);
            reconcileTimer = setTimeout(() => {
                void reconcileSyncingUploads();
                // The owner note of an `orphan_committed` row may just have come back or gone for good.
                void reconcileOrphanUploads();
            }, 500);
        });
    }
}

export async function pingPausedUploads(): Promise<void> {
    const db = await getDB();
    const all = await db.getAll("pending-uploads");
    for (const pending of all) {
        if (pending.phase !== "paused" || !pending.chunk_set_id) continue;
        // One row's failed ping (offline, a 5xx) must neither stop the others nor reject the
        // interval's promise — the next tick tries it again.
        try {
            const result = await pingOrExpire(pending.chunk_set_id);
            if (result === "expired") {
                const { deleteAllUploadChunks } = await import("./upload-chunk-store");
                await deleteAllUploadChunks(pending.local_id);
                if (pending.staging_id) await deleteStaging(pending.staging_id).catch(() => {});
                await db.delete("pending-uploads", pending.local_id);
            }
        } catch {
            // Left as it is.
        }
    }
}

async function processQueue() {
    if (activeUploads >= FILE_LIMITS.MAX_CONCURRENT_UPLOAD_SESSIONS) return;
    const next = uploadQueue.shift();
    if (!next) return;

    activeUploads++;
    try {
        await next();
    } finally {
        activeUploads--;
        processQueue();
    }
}

export function getUploadState(localId: string): UploadState | undefined {
    return states.get(localId);
}

/** Subscribes to one upload's state changes; returns an unsubscribe function. */
export function subscribeUpload(localId: string, cb: () => void): () => void {
    return stateChannel.on(localId, cb);
}

export function subscribeAllUploads(cb: () => void): () => void {
    return stateChannel.on("*", cb);
}

export function getAllUploadStates(): Map<string, UploadState> {
    return states;
}

/** A synchronous check for beforeunload (it has to work without an await). */
export function isUploadBlockingUnload(): boolean {
    if (activeUploads > 0 || pendingUnloadGuard) return true;
    for (const s of states.values()) {
        if (s.status === "uploading") return true;
    }
    return false;
}

/** An async check that includes the IDB pending rows in the active phase. */
export async function hasActiveUploads(): Promise<boolean> {
    if (isUploadBlockingUnload()) return true;
    const db = await getDB();
    const all = await db.getAll("pending-uploads");
    return all.some((p) => isActiveUploadPhase(normalizePending(p).phase));
}

function emit(localId: string): void {
    stateChannel.emit(localId);
    stateChannel.emit("*");
}

function setState(localId: string, patch: Partial<UploadState>): void {
    const prev = states.get(localId) ?? {
        status: "uploading",
        phase: "encrypting",
        chunkIndex: 0,
        totalChunks: 0,
    };
    states.set(localId, { ...prev, ...patch });
    emit(localId);
}

/**
 * Redirect every encFile node from `oldFileId` to `newFileId` (local → real) in one transaction.
 * Exported for callers that receive an upload:complete event without an editor argument of their own in
 * runPendingUpload (a retry from the Sync panel, say, which always calls retryUpload(null, id) because
 * it has no reference to the editor currently open) — without this the live doc stays on local:<id> until the
 * next autosave writes it back over storage that was already patched correctly (see +page.svelte's
 * onUploadComplete).
 */
export function swapFileId(editor: Editor, oldFileId: string, newFileId: string): boolean {
    if (editor.isDestroyed) return false;
    const { state, view } = editor;
    // The pipeline re-pointing a reference: not a removal, and not an undo step. In the history, an
    // undo that came within the grouping delay after it took the swap back with the removal, and
    // the node returned as a `local:` id with no upload behind it.
    const tr = state.tr.setMeta(UPLOAD_REF_META, true).setMeta("addToHistory", false);
    let changed = false;
    let lastPos = -1;
    state.doc.descendants((node, pos) => {
        if (node.type.name === "encFile" && node.attrs.fileId === oldFileId) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, fileId: newFileId });
            lastPos = pos;
            changed = true;
        }
    });
    if (changed) {
        if (lastPos >= 0) {
            try {
                tr.setSelection(NodeSelection.create(tr.doc, lastPos));
            } catch (_) {}
        }
        view.dispatch(tr);
    }
    return changed;
}

/** Remove every encFile node referencing `fileId` (used by Abort). */
export function removeNodes(editor: Editor, fileId: string): void {
    const { state, view } = editor;
    // The upload is aborted already — not a removal that waits out a grace.
    const tr = state.tr.setMeta(UPLOAD_REF_META, true);
    let changed = false;
    const targets: { pos: number; size: number }[] = [];
    state.doc.descendants((node, pos) => {
        if (node.type.name === "encFile" && node.attrs.fileId === fileId) {
            targets.push({ pos, size: node.nodeSize });
        }
    });
    for (const t of targets.reverse()) {
        tr.delete(t.pos, t.pos + t.size);
        changed = true;
    }
    if (changed) view.dispatch(tr);
}

async function refreshUnloadGuard(): Promise<void> {
    if (activeUploads > 0) return;
    const db = await getDB();
    const all = await db.getAll("pending-uploads");
    pendingUnloadGuard = all.some((p) => isActiveUploadPhase(normalizePending(p).phase));
}

function cleanup(localId: string): void {
    states.delete(localId);
    controllers.delete(localId);
    emit(localId);
    void refreshUnloadGuard();
}

async function runPendingUpload(
    editor: Editor | null,
    pending: PendingUpload,
    ac: AbortController,
): Promise<void> {
    const localId = pending.local_id;
    const normalized = normalizePending(pending);

    if (isLockHeldByOtherTab(normalized)) {
        setState(localId, {
            status: "locked_elsewhere",
            error: "Upload continues in another tab",
        });
        return;
    }

    const lock = await acquireUploadLock(localId);
    if (!lock.acquired) {
        setState(localId, {
            status: "locked_elsewhere",
            error: "Upload continues in another tab",
        });
        return;
    }
    const uploadFence = lock.fence;

    const uploadOpts: UploadOptions = {
        signal: ac.signal,
        pendingLocalId: localId,
        uploadFence,
        onProgress: (p) =>
            setState(localId, {
                status: "uploading",
                phase: p.phase,
                // Keep last known chunk totals when phase-only events fire
                // (finalizing / committing / done omit indices).
                ...(p.chunkIndex !== undefined ? { chunkIndex: p.chunkIndex } : {}),
                ...(p.totalChunks !== undefined ? { totalChunks: p.totalChunks } : {}),
                ...(p.chunkPct !== undefined ? { chunkPct: p.chunkPct } : {}),
            }),
    };

    const source = uploadSourceFromPending(normalized, pending.blob);
    if (!source) {
        throw new UploadPipelineError(
            "Upload source unavailable (reload may have lost in-memory file)",
            "fatal_integrity",
            "failed_expired",
        );
    }

    // A row with a session continues it; one that starts over keeps the item id it was given at
    // `opening_session`, so no restart ever mints a second file for it.
    const item = continuesSession(normalized)
        ? await resumeUpload(normalized, uploadOpts)
        : await startNewUpload(source, normalized.parent_id, {
              ...uploadOpts,
              ...(normalized.item_id ? { itemId: normalized.item_id } : {}),
          });

    const oldFileId = LOCAL_PREFIX + localId;
    // A node the editor removed waits out its grace: no swap and no patch of the stored note
    // while it is held — an undo hands the node this id, the end of the grace trashes the file.
    const placement = placeFinishedUpload(localId, item.id);
    if (placement === "trash") {
        // The grace ran out while this upload could no longer be stopped: no READY file is left
        // without an embed.
        const { FileService } = await import("./file-service");
        await FileService.trash(item.id);
    } else if (placement === "place") {
        const swapped = editor ? swapFileId(editor, oldFileId, item.id) : false;
        // The stored note too, even when the editor swapped it — before settleSyncingRow below can
        // release the row (see repointStoredNote). With the editor swapped one look is enough: a note
        // that does not store the ref yet gets the real id from the editor's own save.
        const repointed = await repointStoredNote(localId, normalized.note_id, item.id, {
            attempts: swapped ? 1 : undefined,
        });
        if (repointed === "patched" && !swapped && normalized.note_id) {
            emitNotesChanged([normalized.note_id]);
        }
    }
    emitFilesChanged([item.id]);
    await releaseUploadLock(localId, uploadFence);
    // The row stays (phase `syncing`, set by the pipeline) until the item's push is acknowledged —
    // see reconcileSyncingUploads. Acknowledged already (a fast push) → release it right away.
    await settleSyncingRow(localId);
    window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
    window.dispatchEvent(
        new CustomEvent(APP_EVENTS.uploadComplete, {
            detail: { localId: oldFileId, fileId: item.id },
        }),
    );
    cleanup(localId);
}

/**
 * The phase a failed run leaves its row in. A phase the pipeline already wrote before it threw
 * stays: `orphan_committed` (the set is committed and waits for its owner note), `syncing` (the
 * item exists and waits for its push) and `failed_expired` (the session is gone). Otherwise the
 * error decides — `paused` and `failed_expired` as it says, an upload API refusal by its class (a
 * session that is gone or refused as malformed cannot go on, so a Retry starts over), anything else
 * `failed_recoverable`.
 */
function phaseAfterFailure(written: UploadPhase | undefined, e: unknown): UploadPhase {
    if (written === "orphan_committed" || written === "syncing" || written === "failed_expired") {
        return written;
    }
    if (e instanceof UploadPipelineError && e.phase !== "failed_recoverable") return e.phase;
    if (e instanceof ApiError) {
        const errorClass = classifyUploadError(e);
        if (errorClass === "fatal_session" || errorClass === "fatal_integrity") {
            return "failed_expired";
        }
    }
    return "failed_recoverable";
}

/**
 * Uploads one stashed blob, updating the live state. On success it swaps the node's reference and
 * removes the pending row; on failure it leaves the state as "failed" so the node can offer a Retry.
 * Idempotent: a second
 * call while one is in flight is ignored.
 */
export function startUpload(editor: Editor | null, pending: PendingUpload): Promise<void> {
    ensureUploadHardening();
    return new Promise((resolve) => {
        const localId = pending.local_id;
        if (controllers.has(localId)) {
            resolve();
            return;
        }

        const ac = new AbortController();
        controllers.set(localId, ac);
        setState(localId, {
            status: "uploading",
            phase: "encrypting",
            chunkIndex: 0,
            totalChunks: 0,
        });

        const task = async () => {
            if (ac.signal.aborted) {
                resolve();
                return;
            }

            try {
                await runPendingUpload(editor, pending, ac);
            } catch (e) {
                controllers.delete(localId);
                forgetAbandonedUpload(localId);
                const msg = uploadErrorMessage(e);
                if (!ac.signal.aborted) {
                    const db = await getDB();
                    const row = await db.get("pending-uploads", localId);
                    // A row another tab has taken over is that tab's to write.
                    if (row && !isLockHeldByOtherTab(normalizePending(row))) {
                        await db.put("pending-uploads", {
                            ...row,
                            phase: phaseAfterFailure(row.phase, e),
                            last_error: msg,
                            last_activity_at: Date.now(),
                        });
                    }
                    setState(localId, {
                        status: "failed",
                        error: msg,
                    });
                    import("$lib/core/utils/dev-log").then(({ devWarn }) => {
                        devWarn("upload", `Upload failed for localId ${localId}:`, e);
                    });
                } else {
                    import("$lib/core/utils/dev-log").then(({ devLog }) => {
                        devLog("upload", `Upload aborted for localId ${localId}`);
                    });
                }
                // With no fence: release it if this tab still holds it (the failure path has no local fence in scope).
                await releaseUploadLock(localId);
            } finally {
                resolve();
            }
        };

        uploadQueue.push(task);
        processQueue();
    });
}

export interface TrackedUploadArgs {
    file: File;
    parentId: string | null;
    /** The display name for the sync panel. */
    name: string;
    /** `itemId` is required (a backup restore keeps the original ID, for instance); it is also the state's key. */
    uploadOpts: UploadOptions & { itemId: string };
}

/**
 * Uploads a file THROUGH the shared tracker (the same queue and concurrency as the editor's uploads)
 * so its progress shows in the sync panel, but without the editor or pending-uploads machinery. The
 * import (full-backup) uses it.
 */
export function startTrackedUpload(args: TrackedUploadArgs): Promise<LocalItem> {
    const { file, parentId, name, uploadOpts } = args;
    const id = uploadOpts.itemId;
    return new Promise<LocalItem>((resolve, reject) => {
        const ac = new AbortController();
        controllers.set(id, ac);
        setState(id, {
            status: "uploading",
            phase: "encrypting",
            chunkIndex: 0,
            totalChunks: 0,
            name,
        });

        const task = async () => {
            try {
                const item = await startNewUpload(uploadSourceFromFile(file), parentId, {
                    ...uploadOpts,
                    signal: ac.signal,
                    onProgress: (p) =>
                        setState(id, {
                            name,
                            phase: p.phase,
                            // Keep last known chunk totals when phase-only events fire.
                            ...(p.chunkIndex !== undefined ? { chunkIndex: p.chunkIndex } : {}),
                            ...(p.totalChunks !== undefined ? { totalChunks: p.totalChunks } : {}),
                            ...(p.chunkPct !== undefined ? { chunkPct: p.chunkPct } : {}),
                        }),
                });
                cleanup(id);
                resolve(item);
            } catch (e) {
                controllers.delete(id);
                setState(id, {
                    status: "failed",
                    name,
                    error: e instanceof Error ? e.message : "Upload failed",
                });
                reject(e);
            }
        };

        uploadQueue.push(task);
        processQueue();
    });
}

/** Cancels a tracked upload (the panel's "Abort") — it aborts the request and discards the state. */
export function abortTracked(id: string): void {
    controllers.get(id)?.abort();
    cleanup(id);
}

/** Restarts a failed upload from the pending row that is still present. */
export async function retryUpload(editor: Editor | null, localId: string): Promise<void> {
    const db = await getDB();
    const pending = await db.get("pending-uploads", localId);
    if (pending) {
        await startUpload(editor, pending);
    } else {
        setState(localId, {
            status: "failed",
            phase: "done",
            chunkIndex: 0,
            totalChunks: 0,
            error: "Upload lost (file not found)",
        });
    }
}

/** Cancels an upload, whether in progress or failed: it aborts the request, removes the node and discards the pending row. */
export async function abortPendingUpload(editor: Editor | null, localId: string): Promise<void> {
    controllers.get(localId)?.abort();
    if (editor) removeNodes(editor, LOCAL_PREFIX + localId);
    const db = await getDB();
    const pending = await db.get("pending-uploads", localId);
    if (pending?.chunk_set_id) {
        const { abortUpload } = await import("$lib/core/api/files");
        await abortUpload(pending.chunk_set_id).catch(() => {});
    }
    const { deleteAllUploadChunks } = await import("./upload-chunk-store");
    await deleteAllUploadChunks(localId);
    if (pending?.staging_id) {
        await deleteStaging(pending.staging_id);
    }
    await db.delete("pending-uploads", localId);
    await releaseUploadLock(localId);
    cleanup(localId);
}

/**
 * The end of a removal grace for an upload that still runs: aborted like any cancel — unless
 * another tab holds its lock. That tab owns the row, the staging and the server session, and this
 * tab removed only its own copy of the node; deleting them under a running upload would leave the
 * owner writing to a row that is gone.
 */
export async function abortRemovedUpload(localId: string): Promise<void> {
    const db = await getDB();
    const row = await db.get("pending-uploads", localId);
    if (row && isLockHeldByOtherTab(normalizePending(row))) return;
    await abortPendingUpload(null, localId);
}

/** A best-effort abort of the active server sessions (a user switch before the IDB clear). */
export {
    abortActiveUploadSessions,
    clearAllPendingUploadsOnLogout,
} from "./upload-session-cleanup";

/** Abort every upload in flight in this tab (the logout teardown). */
export function abortAllInFlightUploads(): void {
    for (const ac of controllers.values()) {
        ac.abort();
    }
    controllers.clear();
    states.clear();
    noteRepointed.clear();
}

/**
 * Starts every pending upload accumulated while working offline.
 * `includeFailed` (the `online` handler): rows this tab already marked "failed" in memory — a
 * network failure before the connection came back — are started again too; without it a failed
 * row is retried only after a reload or a manual Retry.
 */
export async function resumeAllPendingUploads(
    opts: { includeFailed?: boolean } = {},
): Promise<void> {
    ensureUploadHardening();
    await sweepStalePendingUploads();
    const db = await getDB();
    const all = await db.getAll("pending-uploads");
    const resumable = all.filter((p) => shouldResumeOnStartup(normalizePending(p).phase));
    pendingUnloadGuard = resumable.length > 0;
    for (const raw of resumable) {
        const pending = normalizePending(raw);
        if (pending.storage_mode === "ephemeral") continue;
        if (
            pending.staging_id &&
            pending.staging_bytes_written !== pending.plain_size &&
            !pending.blob
        ) {
            continue;
        }
        if (isLockHeldByOtherTab(pending)) continue;
        const state = states.get(pending.local_id);
        const canStart = !state || (opts.includeFailed === true && state.status === "failed");
        if (canStart && (await orphanMayResume(pending))) void startUpload(null, pending);
    }
    void reconcileSyncingUploads();
}

/**
 * An `orphan_committed` row waits while its owner note is in the Trash — no network call, no second
 * upload — re-binds once the note is back, and is released when the note is gone for good, with no
 * `DELETE /uploads`: the set is committed and the GC collects it. True when the row may run now;
 * every other phase passes.
 */
export async function orphanMayResume(pending: PendingUpload): Promise<boolean> {
    if (pending.phase !== "orphan_committed") return true;
    const owner = await ownerNoteState(pending);
    if (owner === "ready") return true;
    if (owner === "gone") await cleanupLocalPendingRow(pending);
    return false;
}

/** Re-evaluates the `orphan_committed` rows — on `vaultItemsChanged`, when an owner note may have moved. */
export async function reconcileOrphanUploads(): Promise<void> {
    const db = await getDB();
    const rows = (await db.getAll("pending-uploads")).filter((r) => r.phase === "orphan_committed");
    for (const raw of rows) {
        const pending = normalizePending(raw);
        if (controllers.has(pending.local_id) || isLockHeldByOtherTab(pending)) continue;
        if (!uploadSourceFromPending(pending, pending.blob)) {
            // Its bytes are gone (an ephemeral upload after a reload): it can never be committed,
            // and left as it is, every change of the vault would try again. `failed_expired` lets
            // the node say why, and the sweep collects the row a day later. The committed set has
            // no item, so the GC reclaims it — no DELETE /uploads.
            await db.put("pending-uploads", {
                ...raw,
                phase: "failed_expired",
                last_error: "The file is no longer on this device — add it again",
                last_activity_at: Date.now(),
            });
            continue;
        }
        if (await orphanMayResume(pending)) void startUpload(null, pending);
    }
}

/**
 * One `syncing` row after its item was committed locally: release the row (and the OPFS plaintext
 * staging) only once the item is no longer dirty, i.e. `POST /items/batch` accepted it. A row whose
 * item is gone (deleted before it ever synced) is released too — there is nothing left to protect.
 * Returns true when the row was released.
 */
async function settleSyncingRow(localId: string): Promise<boolean> {
    const db = await getDB();
    const row = await db.get("pending-uploads", localId);
    if (!row) return true;
    if (row.phase !== "syncing" || !row.item_id) {
        // The pipeline returned an item without marking the row `syncing` — there is no item to
        // wait for (the pre-`syncing` contract), so release the row as before.
        await cleanupLocalPendingRow(row);
        noteRepointed.delete(localId);
        return true;
    }
    const item = await db.get("items", row.item_id);
    // A run whose page died before it repointed the note is finished here — before the push is
    // acknowledged, since the item is already local and the embed resolves to it.
    if (item) {
        const repointed = await repointStoredNote(localId, row.note_id, item.id, {
            attempts: 1,
            notifyEditor: true,
        });
        if (repointed === "failed") return false;
    }
    if (item && item.dirty === true) return false;
    await cleanupLocalPendingRow(row);
    noteRepointed.delete(localId);
    return true;
}

/**
 * Before a pending row is released, its owner note has to store the real file id: the row is the
 * only durable record of which file a `local:<id>` embed became. The editor's swap reaches storage
 * through an async save, and a page that died in between (a reload, a closed or killed tab) left the
 * embed on "Upload paused" for good, with nothing left to resolve it.
 *
 * `"failed"` — the note could not be written; the row stays and the next reconcile tries again.
 * `notifyEditor` — an editor showing the note still holds the `local:` node: the note page's
 * upload:complete handler swaps it, so its next save does not write the old ref back.
 */
async function repointStoredNote(
    localId: string,
    noteId: string | null | undefined,
    fileId: string,
    opts: { attempts?: number; notifyEditor?: boolean } = {},
): Promise<"patched" | "unchanged" | "failed"> {
    if (!noteId || noteRepointed.has(localId)) return "unchanged";
    const oldFileId = LOCAL_PREFIX + localId;
    let patched: boolean;
    try {
        patched = await swapFileRefInNoteContent(noteId, oldFileId, fileId, opts.attempts);
    } catch (e) {
        import("$lib/core/utils/dev-log").then(({ devWarn }) => {
            devWarn("upload", `Could not point note ${noteId} at file ${fileId}:`, e);
        });
        return "failed";
    }
    noteRepointed.add(localId);
    if (patched && opts.notifyEditor) {
        emitNotesChanged([noteId]);
        window.dispatchEvent(
            new CustomEvent(APP_EVENTS.uploadComplete, {
                detail: { localId: oldFileId, fileId, noteId },
            }),
        );
    }
    return patched ? "patched" : "unchanged";
}

/**
 * The `syncing` reconciler (see commitUploadedFile): for every row whose item was committed locally
 * but not yet acknowledged by the server, release it once the push lands — or, when the sync engine
 * parked the item because the server no longer has the finalized set (the orphan sweep ran before
 * the item reached it), upload the bytes again from the staging that was kept for exactly this
 * case. Idempotent and cheap; called on startup, on `vaultItemsChanged` and on an interval.
 */
export async function reconcileSyncingUploads(): Promise<number> {
    const db = await getDB();
    const rows = (await db.getAll("pending-uploads")).filter((r) => r.phase === "syncing");
    let released = 0;
    for (const row of rows) {
        if (await settleSyncingRow(row.local_id)) {
            released++;
            continue;
        }
        const item = row.item_id ? await db.get("items", row.item_id) : undefined;
        if (item?.sync_error === CHUNK_SET_NOT_COMMITTED_ERROR) {
            void reuploadFromStaging(row, item);
        }
    }
    return released;
}

/**
 * The server swept the finalized set before the item's push reached it (the item is parked with
 * CHUNK_SET_NOT_COMMITTED_ERROR): re-encrypt and upload the same plaintext into a NEW set under the
 * item's existing Item Key (the crop path), clear the park and push. The item keeps its id — the
 * note's embed stays valid.
 */
async function reuploadFromStaging(row: PendingUpload, item: LocalItem): Promise<void> {
    const localId = row.local_id;
    if (controllers.has(localId)) return;
    if (FileLifecycle.stateOf(item) !== "READY") return; // trashed: wait for a restore
    const source = uploadSourceFromPending(normalizePending(row), row.blob);
    if (!source) {
        // No plaintext left to upload from (an ephemeral row) — the park stays visible in the Sync panel.
        return;
    }
    const ac = new AbortController();
    controllers.set(localId, ac);
    setState(localId, {
        status: "uploading",
        phase: "encrypting",
        chunkIndex: 0,
        totalChunks: 0,
        name: row.name,
    });
    try {
        const db = await getDB();
        // Clear the park FIRST: replaceFileContent marks the item dirty and pushes, and the drain's
        // reconcile skips rows that still carry a sync_error.
        const fresh = await db.get("items", item.id);
        if (!fresh) return;
        delete fresh.sync_error;
        await db.put("items", fresh);
        await replaceFileContent(item.id, source, {
            signal: ac.signal,
            onProgress: (p) =>
                setState(localId, {
                    status: "uploading",
                    phase: p.phase,
                    name: row.name,
                    ...(p.chunkIndex !== undefined ? { chunkIndex: p.chunkIndex } : {}),
                    ...(p.totalChunks !== undefined ? { totalChunks: p.totalChunks } : {}),
                    ...(p.chunkPct !== undefined ? { chunkPct: p.chunkPct } : {}),
                }),
        });
        const current = await db.get("pending-uploads", localId);
        if (current) {
            await db.put("pending-uploads", {
                ...current,
                last_error: undefined,
                last_activity_at: Date.now(),
            });
        }
        emitFilesChanged([item.id]);
        // The push may already be acknowledged (replaceFileContent awaits pushItem).
        await settleSyncingRow(localId);
    } catch (e) {
        const db = await getDB();
        const current = await db.get("pending-uploads", localId);
        if (current) {
            await db.put("pending-uploads", {
                ...current,
                last_error: e instanceof Error ? e.message : "Re-upload failed",
                last_activity_at: Date.now(),
            });
        }
    } finally {
        controllers.delete(localId);
        cleanup(localId);
    }
}
