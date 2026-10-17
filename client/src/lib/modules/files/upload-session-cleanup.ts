// A best-effort cleanup of the upload sessions at logout / in the startup sweep.

import { getUploadStatus } from "$lib/core/api";
import { abortUpload } from "$lib/core/api/files";
import { getDB, type PendingUpload } from "$lib/core/db";
import { deleteStaging } from "./opfs-staging";
import { deleteAllUploadChunks } from "./upload-chunk-store";
import { normalizePending, ownerNoteState } from "./upload-state";

const STALE_STAGING_MS = 24 * 60 * 60 * 1000; // 24h for staging_source
/** How long a `failed_expired` row stays, so its node can still show why it failed. */
const STALE_EXPIRED_MS = 24 * 60 * 60 * 1000;
const STALE_PENDING_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_BLOB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const ACTIVE_SERVER_PHASES = new Set([
    "opening_session",
    "uploading",
    "paused",
    "finalizing",
    "committing_item",
    "orphan_committed",
]);

function needsServerAbort(pending: PendingUpload): boolean {
    const phase = normalizePending(pending).phase;
    return (
        pending.chunk_set_id !== undefined && phase !== undefined && ACTIVE_SERVER_PHASES.has(phase)
    );
}

export async function cleanupLocalPendingRow(pending: PendingUpload): Promise<void> {
    const db = await getDB();
    await deleteAllUploadChunks(pending.local_id);
    if (pending.staging_id) {
        await deleteStaging(pending.staging_id).catch(() => {});
    }
    await db.delete("pending-uploads", pending.local_id);
}

/**
 * Before deleting the pending uploads (logout / a user switch): a best-effort DELETE of the active server sessions.
 */
export async function abortActiveUploadSessions(): Promise<number> {
    const db = await getDB();
    const all = await db.getAll("pending-uploads");
    let aborted = 0;
    for (const pending of all) {
        if (!needsServerAbort(pending)) continue;
        await abortUpload(pending.chunk_set_id!).catch(() => {});
        aborted++;
    }
    return aborted;
}

/**
 * The logout teardown: abort the active server sessions and delete the whole local plaintext upload
 * pipeline (OPFS staging, the IDB blob, pending-uploads, the upload-chunk store).
 */
export async function clearAllPendingUploadsOnLogout(): Promise<void> {
    const db = await getDB();
    const all = await db.getAll("pending-uploads");
    for (const pending of all) {
        if (needsServerAbort(pending)) {
            await abortUpload(pending.chunk_set_id!).catch(() => {});
        }
        await cleanupLocalPendingRow(pending);
    }
    await cleanupOrphanOpfsStaging().catch(() => {});
    try {
        const { cleanupOpfsDownloadTemps } = await import("./download");
        await cleanupOpfsDownloadTemps();
    } catch {
        // download module unavailable in some tests
    }
}

/**
 * The startup sweep: remove the stale pending rows.
 * - uploading/paused + last_activity >7d + session 404
 * - staging_source + last_activity >24h
 * - failed_expired + last_activity >24h — terminal, nothing committed
 * - orphan_committed whose owner note is gone for good — the set is committed, the GC collects it,
 *   so no DELETE /uploads; one whose note is in the Trash waits
 * - legacy blob rows older than 30d
 */
export async function sweepStalePendingUploads(): Promise<number> {
    const db = await getDB();
    const all = await db.getAll("pending-uploads");
    const now = Date.now();
    let removed = 0;

    for (const raw of all) {
        const pending = normalizePending(raw);
        const lastActivity = pending.last_activity_at ?? pending.created_at ?? 0;

        if (
            pending.storage_mode === "idb_blob" &&
            pending.blob &&
            now - pending.created_at > LEGACY_BLOB_MAX_AGE_MS
        ) {
            await cleanupLocalPendingRow(pending);
            removed++;
            continue;
        }

        const phase = pending.phase;
        if (phase === "staging_source" && now - lastActivity > STALE_STAGING_MS) {
            await cleanupLocalPendingRow(pending);
            removed++;
            continue;
        }
        if (phase === "failed_expired" && now - lastActivity > STALE_EXPIRED_MS) {
            await cleanupLocalPendingRow(pending);
            removed++;
            continue;
        }
        if (phase === "orphan_committed" && (await ownerNoteState(pending)) === "gone") {
            await cleanupLocalPendingRow(pending);
            removed++;
            continue;
        }

        if (
            (phase === "uploading" || phase === "paused") &&
            pending.chunk_set_id &&
            now - lastActivity > STALE_PENDING_MS
        ) {
            try {
                const status = await getUploadStatus(pending.chunk_set_id);
                if (status.session_status === "aborted") {
                    await cleanupLocalPendingRow(pending);
                    removed++;
                }
            } catch {
                await abortUpload(pending.chunk_set_id).catch(() => {});
                await cleanupLocalPendingRow(pending);
                removed++;
            }
        }
    }
    await cleanupOrphanOpfsStaging().catch(() => {});
    try {
        const { cleanupOpfsDownloadTemps } = await import("./download");
        await cleanupOpfsDownloadTemps();
    } catch {
        // download module unavailable in some tests
    }
    return removed;
}

/**
 * Sweeps up the orphaned directories in OPFS `uploads/` that have no row in `pending-uploads`.
 */
export async function cleanupOrphanOpfsStaging(): Promise<number> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return 0;
    try {
        const root = await navigator.storage.getDirectory();
        let uploadsDir: FileSystemDirectoryHandle;
        try {
            uploadsDir = await root.getDirectoryHandle("uploads", { create: false });
        } catch {
            return 0;
        }

        const db = await getDB();
        const all = await db.getAll("pending-uploads");
        const activeStagingIds = new Set(all.map((p) => p.staging_id).filter(Boolean));

        let removed = 0;
        for await (const entry of (uploadsDir as any).values()) {
            if (entry.kind === "directory" && !activeStagingIds.has(entry.name)) {
                await uploadsDir.removeEntry(entry.name, { recursive: true }).catch(() => {});
                removed++;
            }
        }
        return removed;
    } catch {
        return 0;
    }
}
