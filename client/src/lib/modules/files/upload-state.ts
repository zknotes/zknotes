// The types and helpers for the resumable-upload state machine.
import { FILE_LIMITS } from "@zknotes/shared";
import { getDB, type PendingUpload } from "$lib/core/db";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";

export type UploadPhase =
    | "awaiting_confirm"
    | "staging_source"
    | "opening_session"
    | "uploading"
    | "paused"
    | "finalizing"
    | "committing_item"
    | "syncing"
    | "orphan_committed"
    | "done"
    | "user_aborted"
    | "failed_recoverable"
    | "failed_expired";

export interface ManifestChunkEntry {
    nonce: string;
    hash: string;
    size: number;
    local_state: "persisted" | "confirmed";
}

/** The phases in which an upload is active — used by the beforeunload guard. */
export const ACTIVE_UPLOAD_PHASES: ReadonlySet<UploadPhase> = new Set([
    "staging_source",
    "opening_session",
    "uploading",
    "paused",
    "finalizing",
    "committing_item",
]);

export function isResumablePhase(phase: UploadPhase | undefined): boolean {
    return (
        phase === "uploading" ||
        phase === "paused" ||
        phase === "opening_session" ||
        phase === "failed_recoverable" ||
        phase === "orphan_committed" ||
        phase === "staging_source"
    );
}

/**
 * The one resume predicate — the startup resume and the note-open resume both ask it. A `syncing`
 * row is not restarted but left to the reconciler: its item exists already.
 */
export function shouldResumeOnStartup(phase: UploadPhase | undefined): boolean {
    if (!phase) return true;
    if (phase === "done" || phase === "user_aborted" || phase === "failed_expired") return false;
    return isResumablePhase(phase) || phase === "finalizing" || phase === "committing_item";
}

/**
 * A row that already has a server session continues it (`resumeUpload`) instead of starting over.
 * `finalizing` and `committing_item` belong here: started over, they minted a second file for a set
 * that was already finalized.
 */
export function continuesSession(pending: Pick<PendingUpload, "phase" | "chunk_set_id">): boolean {
    return (
        pending.chunk_set_id !== undefined &&
        (isResumablePhase(pending.phase) ||
            pending.phase === "finalizing" ||
            pending.phase === "committing_item")
    );
}

export type OwnerNoteState = "ready" | "trashed" | "gone";

/**
 * Where the note an upload belongs to stands. A row whose parent is not a note has no owner to wait
 * for, so it counts as `ready`.
 */
export async function ownerNoteState(
    pending: Pick<PendingUpload, "parent_id">,
): Promise<OwnerNoteState> {
    if (!pending.parent_id) return "ready";
    const db = await getDB();
    const parent = await db.get("items", pending.parent_id);
    if (!parent) return "gone";
    if (parent.type !== "note") return "ready";
    const state = FileLifecycle.stateOf(parent);
    return state === "READY" ? "ready" : state === "TRASHED" ? "trashed" : "gone";
}

export function isActiveUploadPhase(phase: UploadPhase | undefined): boolean {
    return phase !== undefined && ACTIVE_UPLOAD_PHASES.has(phase);
}

export function chunkPlan(file: File | { size: number }): {
    chunkSize: number;
    totalChunks: number;
    ciphertextSize: number;
    chunkSizes: number[];
} {
    const chunkSize = FILE_LIMITS.CHUNK_SIZE;
    const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
    const chunkSizes: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
        const plainChunkSize = Math.min(chunkSize, file.size - i * chunkSize);
        chunkSizes.push(plainChunkSize + FILE_LIMITS.AEAD_TAG);
    }
    const ciphertextSize = file.size + totalChunks * FILE_LIMITS.AEAD_TAG;
    return { chunkSize, totalChunks, ciphertextSize, chunkSizes };
}

/** The minimal fields for a new pending-uploads row (the v8 schema). */
export function createPendingUploadBase(
    localId: string,
    file: { name: string; type: string; size: number },
    noteId: string | null,
    parentId: string | null,
): PendingUpload {
    const now = Date.now();
    return {
        local_id: localId,
        phase: "staging_source",
        name: file.name,
        mime: file.type || "application/octet-stream",
        plain_size: file.size,
        note_id: noteId,
        parent_id: parentId,
        created_at: now,
        last_activity_at: now,
        manifest: {},
    };
}

/** Normalises the legacy rows (pre-v8) onto the new schema. */
export function normalizePending(pending: PendingUpload): PendingUpload {
    const now = Date.now();
    return {
        ...pending,
        phase: pending.phase ?? "staging_source",
        plain_size: pending.plain_size ?? pending.blob?.size ?? 0,
        last_activity_at: pending.last_activity_at ?? pending.created_at ?? now,
        manifest: pending.manifest ?? {},
    };
}
