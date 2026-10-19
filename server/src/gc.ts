// Sweeper and reconciliation.
//
// runGc()        — frequent (~15 min), DB-DRIVEN: deletes expired sessions, dead upload sessions,
//                  and chunk sets marked pending_delete that are past BLOB_PURGE_GRACE.
// runDeepRepair() — rare (~weekly), the ONLY path that scans the S3 bucket (prefix u/):
//                  it finds orphan directories and ghost rows.
//
// Invariant: the DB row changes BEFORE anything is physically deleted from disk. A crash between
// those two steps leaves an orphan on disk, which the next runDeepRepair() reclaims. Never the
// other way round. Idempotent; safe to repeat.

import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { FILE_LIMITS } from "@zknotes/shared";
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { markPendingDelete } from "./blob-sweeper";
import { db } from "./db";
import {
    chunkSets,
    fileChunks,
    gcRuns,
    items,
    restoreSessions,
    sessions,
    shareLinks,
    syncDeletedLog,
    uploadSessions,
    users,
} from "./db/schema";
import type { DbExecutor } from "./db/types";
import { nowSec } from "./lib/time";
import { recomputeUserQuota, updateQuotaTx } from "./services/quota-service";
import { releaseRestoreStaging } from "./services/restore-service";
import { S3_BUCKET, s3 } from "./s3";
import { purgeOwnedItem } from "./services/item-service";
import { purgeStaleSignInFailures } from "./services/login-throttle";
import { deleteS3Prefix, listObjects, prefixHasObjects } from "./services/storage-service";

// BLOB_PURGE_GRACE: how many seconds we wait between the pending_delete mark and the physical
// deletion. Default 1h — it gives a window for a crop undo.
const DEFAULT_BLOB_PURGE_GRACE = Number(process.env.BLOB_PURGE_GRACE_SECONDS ?? 3600);
const DEFAULT_STALE_UPLOAD_SECONDS = Number(process.env.GC_STALE_UPLOAD_SECONDS ?? 24 * 3600);
// TOMBSTONE_PURGE_DAYS: how many days a purged_at tombstone lives in items before it is physically
// deleted. It may be short — the long-term delta-sync signal is carried by sync_deleted_log.
const DEFAULT_TOMBSTONE_PURGE_SECONDS = Number(process.env.TOMBSTONE_PURGE_DAYS ?? 30) * 24 * 3600;
// SYNC_DELETED_LOG_RETENTION_DAYS: how long sync_deleted_log lives (default 2 years). A client
// whose watermark is older than this has to do a full re-bootstrap.
const DEFAULT_DELETED_LOG_RETENTION_SECONDS =
    Number(process.env.SYNC_DELETED_LOG_RETENTION_DAYS ?? 730) * 24 * 3600;
// TRASH_RETENTION_DAYS: how many days deleted items (deleted_at) survive in Trash before GC
// hard-deletes (purges) them automatically.
const DEFAULT_TRASH_RETENTION_SECONDS = Number(process.env.TRASH_RETENTION_DAYS ?? 30) * 24 * 3600;
const DEFAULT_SHARE_ROW_RETENTION_SECONDS =
    Number(process.env.SHARE_ROW_RETENTION_DAYS ?? 90) * 24 * 3600;
// Minimum age of a committed chunk set with no item row before runGc marks it an orphan.
const DEFAULT_ORPHAN_CHUNK_SET_MIN_AGE_SECONDS = Number(
    process.env.GC_ORPHAN_CHUNK_SET_MIN_AGE_SECONDS ?? 24 * 3600,
);

/**
 * The extension point for GC. The core cleans its own tables; an extension registers a step that
 * cleans its own.
 *
 * Registration is **idempotent by name** — the tests build several apps in one process, so the same
 * step would otherwise accumulate and the counters would double.
 */
export type GcStep = {
    readonly name: string;
    /** Returns named counters; they end up in `GcResult.extensions`. `userId` = GC for a single user. */
    run(now: number, opts: { readonly userId?: string }): Promise<Record<string, number>>;
};

const gcSteps = new Map<string, GcStep>();

export function registerGcStep(step: GcStep): void {
    gcSteps.set(step.name, step);
}

/**
 * The blob behind an upload session is gone (the pending_delete sweep, or a ghost row in
 * deep-repair) — the session must stop answering `committed`. A client that finalized this set but
 * whose item commit or item push never reached the server (a tab closed after finalize, an owner
 * note trashed, a laptop offline for a day) resumes by asking `GET /uploads/:id/status`; with the
 * session still `committed` it would bind a NEW item to bytes that no longer exist, delete its own
 * plaintext staging, and then be refused by `POST /items/batch` forever. `purged` makes
 * `/status` tell the truth and `/finalize` answer 409, so the client re-uploads from its staging.
 * The row itself is swept by section B once it is older than the stale-upload window.
 */
async function markUploadSessionPurged(
    tx: DbExecutor,
    chunkSetId: string,
    now: number,
): Promise<void> {
    await tx
        .update(uploadSessions)
        .set({ status: "purged", updated_at: now })
        .where(and(eq(uploadSessions.id, chunkSetId), eq(uploadSessions.status, "committed")));
}

export interface GcOptions {
    blobPurgeGrace?: number;
    staleUploadSeconds?: number;
    tombstonePurgeSeconds?: number;
    deletedLogRetentionSeconds?: number;
    trashRetentionSeconds?: number;
    /** Minimum seconds since chunk_sets.created_at before marking an orphan; 0 = disabled (tests). */
    orphanChunkSetMinAgeSeconds?: number;
    shareRowRetentionSeconds?: number;
    now?: number; // override "now" (seconds) — the tests
    userId?: string;
}

export interface GcResult {
    authSessions: number;
    /** Sign-in failure runs that are neither locked nor inside their window any more. */
    signInFailures: number;
    /** Counters from registered extension steps. Empty with no extension. */
    extensions: Record<string, number>;
    uploadSessions: number;
    blobsPurged: number;
    bytesReclaimed: number;
    autoPurgedItems: number;
    orphanChunkSetsMarked: number;
    itemTombstones: number;
    deletedLogRows: number;
    shareLinksExpired: number;
    shareLinksDeleted: number;
    restoreSessions: number;
}

/**
 * A DB-driven sweep:
 *   A. Expired auth sessions
 *   A.1. Lapsed sign-in failure runs (login_failures)
 *   B. Dead upload sessions (aborted, or idle past the staleness window)
 *   C. Committed chunk sets whose pending_delete_at is past BLOB_PURGE_GRACE → physical deletion
 *   C.1. Old committed orphan chunk sets (with no item) → pending_delete + release quota
 *   D. items tombstones (purged_at) older than TOMBSTONE_PURGE_DAYS → physical row deletion
 *   E. sync_deleted_log entries older than SYNC_DELETED_LOG_RETENTION → deletion
 */
export async function runGc(opts: GcOptions = {}): Promise<GcResult> {
    const now = opts.now ?? nowSec();
    const blobPurgeGrace = opts.blobPurgeGrace ?? DEFAULT_BLOB_PURGE_GRACE;
    const staleUploadSeconds = opts.staleUploadSeconds ?? DEFAULT_STALE_UPLOAD_SECONDS;
    const tombstonePurgeSeconds = opts.tombstonePurgeSeconds ?? DEFAULT_TOMBSTONE_PURGE_SECONDS;
    const deletedLogRetentionSeconds =
        opts.deletedLogRetentionSeconds ?? DEFAULT_DELETED_LOG_RETENTION_SECONDS;
    const shareRowRetentionSeconds =
        opts.shareRowRetentionSeconds ?? DEFAULT_SHARE_ROW_RETENTION_SECONDS;
    const orphanChunkSetMinAgeSeconds =
        opts.orphanChunkSetMinAgeSeconds ?? DEFAULT_ORPHAN_CHUNK_SET_MIN_AGE_SECONDS;
    let authSessions = 0;
    let uploadSessionCount = 0;
    let blobsPurged = 0;
    let bytesReclaimed = 0;

    // ── A. Expired auth sessions ────────────────────────────────────────────────
    const deletedSessions = await db
        .delete(sessions)
        .where(
            and(
                lt(sessions.expires_at, now),
                opts.userId ? eq(sessions.user_id, opts.userId) : undefined,
            ),
        )
        .returning({ id: sessions.id });
    authSessions = deletedSessions.length;

    // ── A.1. Lapsed sign-in failure runs ────────────────────────────────────────
    // Not per user: a run belongs to a source as much as to an account.
    const signInFailures = opts.userId ? 0 : await purgeStaleSignInFailures(now);

    // Extension steps (the seam: `registerGcStep`). With no extension registered this is empty.
    const extensionCounts: Record<string, number> = {};
    for (const step of gcSteps.values()) {
        Object.assign(extensionCounts, await step.run(now, { userId: opts.userId }));
    }

    // ── B. Aborted, idle or purged upload sessions ──────────────────────────────
    // abortTxn already frees storage_used_files synchronously and sets status=aborted.
    // GC may free quota ONLY for a stale `uploading` session (one that never went through the abort
    // path). For `aborted` it only deletes the rows and the S3 objects (bytesReclaimed still counts
    // the size, for ops). Aborted rows are kept until the presigned PUT TTL elapses so a PUT issued
    // before abort cannot land as an unmetered orphan after the row is gone.
    // `purged` (section C flipped it when the blob was swept) is kept for the stale-upload window so
    // a resuming client still gets a truthful `/status`, then dropped — its bytes were reclaimed by
    // the sweep and its objects are gone, so it is a row-only delete here.
    const abortedCutoff = now - FILE_LIMITS.PRESIGNED_PUT_EXPIRES_SEC;
    const uploadingCutoff = now - staleUploadSeconds;
    const deadUploadCondition = or(
        and(eq(uploadSessions.status, "aborted"), lte(uploadSessions.updated_at, abortedCutoff)),
        and(
            eq(uploadSessions.status, "uploading"),
            lte(uploadSessions.updated_at, uploadingCutoff),
        ),
        and(eq(uploadSessions.status, "purged"), lte(uploadSessions.updated_at, uploadingCutoff)),
    );
    const deadUploads = await db
        .select({
            id: uploadSessions.id,
            user_id: uploadSessions.user_id,
            total_size: uploadSessions.total_size,
            status: uploadSessions.status,
        })
        .from(uploadSessions)
        .where(
            and(
                deadUploadCondition,
                opts.userId ? eq(uploadSessions.user_id, opts.userId) : undefined,
            ),
        );

    for (const s of deadUploads) {
        const deleted = await db.transaction(async (tx) => {
            const [fresh] = await tx
                .select({
                    id: uploadSessions.id,
                    user_id: uploadSessions.user_id,
                    total_size: uploadSessions.total_size,
                    status: uploadSessions.status,
                })
                .from(uploadSessions)
                .where(and(eq(uploadSessions.id, s.id), deadUploadCondition))
                .for("update")
                .limit(1);
            if (!fresh) return null;
            if (fresh.status === "uploading" && fresh.total_size > 0) {
                await updateQuotaTx(tx, fresh.user_id, { files: -fresh.total_size }, false);
            }
            await tx.delete(fileChunks).where(eq(fileChunks.chunk_set_id, fresh.id));
            await tx.delete(uploadSessions).where(eq(uploadSessions.id, fresh.id));
            return fresh;
        });
        if (!deleted) continue;
        if (deleted.status === "purged") {
            // The blob sweep already deleted the objects and counted the bytes — a row-only cleanup.
            uploadSessionCount++;
            continue;
        }
        await deleteS3Prefix(deleted.user_id, deleted.id);
        uploadSessionCount++;
        bytesReclaimed += Number(deleted.total_size);
    }

    // ── C. pending_delete sweeper: physical deletion of blobs past the grace window ──
    // This is the ONLY place where blobs are physically deleted.
    // The request path NEVER touches disk or R2 — it only sets pending_delete_at.
    const pendingBlobs = await db
        .select({ id: chunkSets.id, user_id: chunkSets.user_id, total_size: chunkSets.total_size })
        .from(chunkSets)
        .where(
            and(
                isNotNull(chunkSets.pending_delete_at),
                lte(chunkSets.pending_delete_at, now - blobPurgeGrace),
                opts.userId ? eq(chunkSets.user_id, opts.userId) : undefined,
            ),
        );

    for (const cs of pendingBlobs) {
        const deleted = await db.transaction(async (tx) => {
            // The DB row FIRST — a crash after this leaves an orphan on disk, not a ghost row.
            // The condition is checked again on the row itself: between the scan above and this
            // statement a conflict copy can take the set back (reclaimChunkSetFromPendingDelete
            // clears pending_delete_at), and deleting it then would delete a live file.
            const [gone] = await tx
                .delete(chunkSets)
                .where(
                    and(
                        eq(chunkSets.id, cs.id),
                        isNotNull(chunkSets.pending_delete_at),
                        lte(chunkSets.pending_delete_at, now - blobPurgeGrace),
                    ),
                )
                .returning({ id: chunkSets.id });
            if (!gone) return false;
            // file_chunks has no FK or cascade to chunk_sets (deliberately) — we have
            // to delete it explicitly here, or the rows stay orphaned forever after a purge.
            await tx.delete(fileChunks).where(eq(fileChunks.chunk_set_id, cs.id));
            // Note: storage_used was already updated when the item was purged
            // (DELETE /items/:id/purge). We do NOT update it again here, to avoid subtracting twice.
            await markUploadSessionPurged(tx, cs.id, now);
            return true;
        });
        if (!deleted) continue;
        // Physical deletion of the S3 objects AFTER the DB commit
        await deleteS3Prefix(cs.user_id, cs.id);
        blobsPurged++;
        bytesReclaimed += Number(cs.total_size);
    }

    // ── C.1. Old committed orphan chunk sets (a finalize with no item) ──
    // Age guard: fresh sets wait for the item.create batch to arrive. Deep-repair uses the same floor.
    let orphanChunkSetsMarked = 0;
    if (orphanChunkSetMinAgeSeconds > 0) {
        const staleOrphans = await db
            .select({
                id: chunkSets.id,
                user_id: chunkSets.user_id,
                total_size: chunkSets.total_size,
            })
            .from(chunkSets)
            .where(
                and(
                    isNull(chunkSets.pending_delete_at),
                    lte(chunkSets.created_at, now - orphanChunkSetMinAgeSeconds),
                    opts.userId ? eq(chunkSets.user_id, opts.userId) : undefined,
                    sql`NOT EXISTS (
                        SELECT 1 FROM ${items}
                        WHERE ${items.chunk_set_id} = ${chunkSets.id}
                          AND ${items.user_id} = ${chunkSets.user_id}
                    )`,
                    sql`NOT EXISTS (
                        SELECT 1 FROM ${restoreSessions} rs
                        WHERE rs.id = ${chunkSets.restore_session_id}
                          AND rs.status = 'open'
                    )`,
                ),
            );

        for (const cs of staleOrphans) {
            const marked = await db.transaction(async (tx) => {
                const [stillOrphan] = await tx
                    .select({ id: chunkSets.id, total_size: chunkSets.total_size })
                    .from(chunkSets)
                    .where(
                        and(
                            eq(chunkSets.id, cs.id),
                            isNull(chunkSets.pending_delete_at),
                            sql`NOT EXISTS (
                                SELECT 1 FROM ${items}
                                WHERE ${items.chunk_set_id} = ${chunkSets.id}
                                  AND ${items.user_id} = ${chunkSets.user_id}
                            )`,
                            sql`NOT EXISTS (
                                SELECT 1 FROM ${restoreSessions} rs
                                WHERE rs.id = ${chunkSets.restore_session_id}
                                  AND rs.status = 'open'
                            )`,
                        ),
                    )
                    .limit(1);
                if (!stillOrphan) return false;

                await markPendingDelete(stillOrphan.id, cs.user_id, tx);
                const size = stillOrphan.total_size;
                if (size > 0) {
                    await updateQuotaTx(tx, cs.user_id, { files: -size }, false);
                }
                return true;
            });
            if (marked) orphanChunkSetsMarked++;
        }
    }

    // ── C.2. Trash retention (Trash grows without bound) ──
    // Deleted items (deleted_at) older than TRASH_RETENTION_DAYS are purged automatically
    // (the hard-delete logic, including releasing the quota and marking the blob pending_delete).
    let autoPurgedItems = 0;
    // One source of truth for the cutoff — the same expression goes into the candidate SELECT and
    // into the re-check inside the transaction (see below); otherwise the guard would protect a
    // different boundary from the one the candidates were chosen by.
    const trashCutoff = now - (opts.trashRetentionSeconds ?? DEFAULT_TRASH_RETENTION_SECONDS);
    const expiredTrash = await db
        .select({
            id: items.id,
            user_id: items.user_id,
        })
        .from(items)
        .where(
            and(
                isNotNull(items.deleted_at),
                isNull(items.purged_at),
                lte(items.deleted_at, trashCutoff),
                opts.userId ? eq(items.user_id, opts.userId) : undefined,
            ),
        )
        .limit(1000); // Batching to prevent transaction bloat

    for (const item of expiredTrash) {
        await db.transaction(async (tx) => {
            // purgeOwnedItem takes a FOR UPDATE lock and re-checks inside the transaction. That
            // covers two things:
            //  1. `purged_at` — a parallel user-initiated purge of the same item (via the route or
            //     batch delete_ids) would otherwise proceed on a stale snapshot and release the
            //     chunk-set quota twice (see releaseChunkSetIfUnreferenced);
            //  2. `expiredTrashOnly` — the SELECT above runs OUTSIDE the transaction, so the user
            //     may have restored the item from Trash meanwhile. Without passing the cutoff
            //     through, a restore would silently lose the race against this sweep. The guard is
            //     opt-in because a direct hard delete of a READY row through delete_ids is a
            //     supported contract — but NOT here.
            const purged = await purgeOwnedItem(tx, item.id, item.user_id, now, undefined, {
                expiredTrashOnly: { cutoff: trashCutoff },
            });
            if (purged) autoPurgedItems++;
        });
    }

    // ── D. items tombstones older than TOMBSTONE_PURGE_DAYS → physical row deletion ──
    // The lasting "this was deleted" signal is carried by sync_deleted_log, so a purged_at row
    // serves only devices that are syncing right now. The parent_id FK is ON DELETE CASCADE, and
    // the cascade runs all the way down: deleting a tombstone takes its children, their children
    // and so on with it. So a tombstone is deleted only while NO row references it as a parent.
    // First, though, every link between two expired tombstones is cut — otherwise two tombstones
    // whose parents form a cycle, or a chain of them, would keep each other forever. A live (or
    // trashed, or fresh) row keeps its parent, and with it everything above it stays.
    const tombstoneCutoff = now - tombstonePurgeSeconds;
    await db
        .update(items)
        .set({ parent_id: null })
        .where(
            and(
                isNotNull(items.purged_at),
                lte(items.purged_at, tombstoneCutoff),
                opts.userId ? eq(items.user_id, opts.userId) : undefined,
                sql`${items.parent_id} IN (
                    SELECT parents.id FROM ${items} AS parents
                    WHERE parents.purged_at IS NOT NULL AND parents.purged_at <= ${tombstoneCutoff}
                )`,
            ),
        );
    const purgedTombstones = await db
        .delete(items)
        .where(
            and(
                isNotNull(items.purged_at),
                lte(items.purged_at, tombstoneCutoff),
                opts.userId ? eq(items.user_id, opts.userId) : undefined,
                sql`NOT EXISTS (
                    SELECT 1 FROM ${items} AS children WHERE children.parent_id = ${items.id}
                )`,
            ),
        )
        .returning({ id: items.id });
    const itemTombstones = purgedTombstones.length;

    // ── E. sync_deleted_log retention — the log is tiny and lives for years; once it expires, a
    // client with a watermark that old has to do a full re-bootstrap anyway ──
    const expiredLogRows = await db
        .delete(syncDeletedLog)
        .where(
            and(
                lte(syncDeletedLog.deleted_at, now - deletedLogRetentionSeconds),
                opts.userId ? eq(syncDeletedLog.user_id, opts.userId) : undefined,
            ),
        )
        .returning({ item_id: syncDeletedLog.item_id });
    const deletedLogRows = expiredLogRows.length;

    // ── Restore: expired open sessions + cleanup of aborted/expired ───────────
    let restoreSessionCount = 0;
    await db
        .update(restoreSessions)
        .set({ status: "expired", updated_at: now })
        .where(
            and(
                eq(restoreSessions.status, "open"),
                lt(restoreSessions.expires_at, now),
                opts.userId ? eq(restoreSessions.user_id, opts.userId) : undefined,
            ),
        );

    const deadRestores = await db
        .select()
        .from(restoreSessions)
        .where(
            and(
                or(eq(restoreSessions.status, "aborted"), eq(restoreSessions.status, "expired")),
                opts.userId ? eq(restoreSessions.user_id, opts.userId) : undefined,
            ),
        );
    for (const session of deadRestores) {
        const prefixes = await db.transaction(async (tx) => {
            const { prefixes: p } = await releaseRestoreStaging(tx, session);
            await tx.delete(restoreSessions).where(eq(restoreSessions.id, session.id));
            return p;
        });
        for (const p of prefixes) {
            await deleteS3Prefix(p.userId, p.id);
        }
        restoreSessionCount++;
    }

    // ── F. share_links expiry sweep + retention of the old rows ──
    let shareLinksExpired = 0;
    if (!opts.userId) {
        const expiredShares = await db
            .update(shareLinks)
            // burn_grace_until: an expired link serves nothing, not even a burn's leftover window.
            .set({ revoked_at: now, burn_grace_until: null, updated_at: now })
            .where(
                and(
                    isNull(shareLinks.revoked_at),
                    sql`${shareLinks.expires_at} IS NOT NULL`,
                    lte(shareLinks.expires_at, now),
                ),
            )
            .returning({ id: shareLinks.id });
        shareLinksExpired = expiredShares.length;
    }

    let shareLinksDeleted = 0;
    if (!opts.userId) {
        const oldShares = await db
            .delete(shareLinks)
            .where(
                and(
                    lte(shareLinks.created_at, now - shareRowRetentionSeconds),
                    or(
                        isNotNull(shareLinks.revoked_at),
                        and(isNotNull(shareLinks.expires_at), lte(shareLinks.expires_at, now)),
                    ),
                ),
            )
            .returning({ id: shareLinks.id });
        shareLinksDeleted = oldShares.length;
    }

    return {
        authSessions,
        signInFailures,
        extensions: extensionCounts,
        uploadSessions: uploadSessionCount,
        blobsPurged,
        bytesReclaimed,
        autoPurgedItems,
        orphanChunkSetsMarked,
        itemTombstones,
        deletedLogRows,
        shareLinksExpired,
        shareLinksDeleted,
        restoreSessions: restoreSessionCount,
    };
}

export interface DeepRepairResult {
    orphanDirs: number; // disk directories with no DB record
    ghostRows: number; // DB chunk_set rows with no directory on disk
    committedOrphans: number; // committed chunk sets with no item at all
    usersReconciled: number;
}

export interface DeepRepairOptions {
    now?: number;
    staleUploadSeconds?: number;
    /** Minimum seconds since chunk_sets.created_at before marking an orphan; 0 = no age guard. */
    orphanChunkSetMinAgeSeconds?: number;
}

/**
 * The FS-scanning reconcile — the only O(all sets) path; run it rarely (~weekly).
 *
 * Sections:
 *   1. S3 objects with no DB record → delete the objects (orphans left by a crash between the DB
 *      and S3 operations)
 *   2. DB chunk_set rows whose prefix does not exist in S3 → DROP the row (ghost rows, drift)
 *   3. Committed chunk sets with no item referencing them → pending_delete
 *   4. Reconcile storage_used for every user against the real state
 */
export async function runDeepRepair(opts: DeepRepairOptions = {}): Promise<DeepRepairResult> {
    let orphanDirs = 0;
    let ghostRows = 0;
    let committedOrphans = 0;
    const now = opts.now ?? nowSec();
    const staleUploadSeconds = opts.staleUploadSeconds ?? DEFAULT_STALE_UPLOAD_SECONDS;
    const orphanChunkSetMinAgeSeconds =
        opts.orphanChunkSetMinAgeSeconds ?? DEFAULT_ORPHAN_CHUNK_SET_MIN_AGE_SECONDS;
    const objectStaleCutoffMs = (now - staleUploadSeconds) * 1000;

    // The set of every known chunk_set ID (committed) and upload ID (including aborted — their
    // presigned PUTs may still land until PRESIGNED_PUT_EXPIRES_SEC).
    const knownSets = await db.select({ id: chunkSets.id }).from(chunkSets);
    const knownUploads = await db.select({ id: uploadSessions.id }).from(uploadSessions);
    const known = new Set<string>([
        ...knownSets.map((r) => r.id),
        ...knownUploads.map((r) => r.id),
    ]);

    // 1. S3 objects the DB does not know about → delete
    try {
        const batchToDelete: { Key: string }[] = [];
        for await (const obj of listObjects("u/")) {
            const parts = obj.key.split("/");
            if (parts.length < 4) continue;
            const cs = parts[2];
            if (!cs || known.has(cs)) continue;
            // Skip objects newer than the stale-upload window — a session opened after the
            // snapshot, or a PUT still in flight, must not be deleted.
            if (obj.lastModified && obj.lastModified.getTime() > objectStaleCutoffMs) continue;
            batchToDelete.push({ Key: obj.key });
        }

        if (batchToDelete.length > 0) {
            const candidateIds = [
                ...new Set(
                    batchToDelete
                        .map((o) => o.Key.split("/")[2])
                        .filter((id): id is string => !!id),
                ),
            ];
            const nowKnown = new Set<string>();
            if (candidateIds.length > 0) {
                const liveSets = await db
                    .select({ id: chunkSets.id })
                    .from(chunkSets)
                    .where(inArray(chunkSets.id, candidateIds));
                const liveUploads = await db
                    .select({ id: uploadSessions.id })
                    .from(uploadSessions)
                    .where(inArray(uploadSessions.id, candidateIds));
                for (const r of liveSets) nowKnown.add(r.id);
                for (const r of liveUploads) nowKnown.add(r.id);
            }
            const confirmed = batchToDelete.filter((o) => {
                const cs = o.Key.split("/")[2];
                return !!cs && !nowKnown.has(cs);
            });
            // S3 limits DeleteObjects to 1000 per request
            for (let i = 0; i < confirmed.length; i += 1000) {
                await s3.send(
                    new DeleteObjectsCommand({
                        Bucket: S3_BUCKET,
                        Delete: { Objects: confirmed.slice(i, i + 1000) },
                    }),
                );
            }
            orphanDirs += confirmed.length; // Count the deleted objects as orphan "directories", for compatibility
        }
    } catch {
        // Log the S3 error, or ignore it
    }

    // 2. DB chunk_set rows whose objects do not exist in S3 → DROP the row (ghost/drift)
    // Do NOT drop a set still referenced by a non-purged item (a dangling item beats a silent
    // drop).
    const allSets = await db
        .select({ id: chunkSets.id, user_id: chunkSets.user_id })
        .from(chunkSets);
    for (const cs of allSets) {
        try {
            if (!(await prefixHasObjects(`u/${cs.user_id}/${cs.id}/`))) {
                const [liveRef] = await db
                    .select({ id: items.id })
                    .from(items)
                    .where(
                        and(
                            eq(items.chunk_set_id, cs.id),
                            eq(items.user_id, cs.user_id),
                            isNull(items.purged_at),
                        ),
                    )
                    .limit(1);
                if (liveRef) {
                    // A live item with empty S3 — an ops incident; do not delete the DB metadata.
                    continue;
                }
                await db.transaction(async (tx) => {
                    await tx.delete(fileChunks).where(eq(fileChunks.chunk_set_id, cs.id));
                    await tx.delete(chunkSets).where(eq(chunkSets.id, cs.id));
                    // The same truth as section C: no bytes → the session may not say `committed`.
                    await markUploadSessionPurged(tx, cs.id, now);
                });
                ghostRows++;
            }
        } catch {
            // ignore
        }
    }

    // 3. Committed chunk sets with no item referencing them (the orphan branch)
    const orphanedSets = await db
        .select({ id: chunkSets.id, user_id: chunkSets.user_id })
        .from(chunkSets)
        .where(
            and(
                sql`${chunkSets.pending_delete_at} IS NULL`,
                orphanChunkSetMinAgeSeconds > 0
                    ? lte(chunkSets.created_at, now - orphanChunkSetMinAgeSeconds)
                    : undefined,
                sql`NOT EXISTS (
                    SELECT 1 FROM ${items}
                    WHERE ${items.chunk_set_id} = ${chunkSets.id}
                      AND ${items.user_id} = ${chunkSets.user_id}
                )`,
                sql`NOT EXISTS (
                    SELECT 1 FROM ${restoreSessions} rs
                    WHERE rs.id = ${chunkSets.restore_session_id}
                      AND rs.status = 'open'
                )`,
            ),
        );
    for (const cs of orphanedSets) {
        await db.update(chunkSets).set({ pending_delete_at: now }).where(eq(chunkSets.id, cs.id));
        committedOrphans++;
    }

    // 4. Reconcile the 4-counter storage model (v2 quota) — the formula lives in the quota service
    // (recomputeUserQuota); the operator's backfill script runs the same function.
    const allUsers = await db.select({ id: users.id }).from(users);
    for (const u of allUsers) {
        await db.transaction((tx) => recomputeUserQuota(tx, u.id));
    }
    const reconciled = allUsers;

    return { orphanDirs, ghostRows, committedOrphans, usersReconciled: reconciled.length };
}

/** The `gc_runs` row of the deep repair. */
export const DEEP_REPAIR_JOB = "deep_repair";
/**
 * How long a claimed deep repair holds the job — longer than a full bucket scan takes — and so also
 * how long a failed one waits before the next try, instead of retrying on every 15-minute tick.
 */
export const DEEP_REPAIR_LEASE_SECONDS = 6 * 60 * 60;

export interface DeepRepairScheduleOptions {
    now?: number;
    /** GC_DEEP_INTERVAL_MS in seconds: due when the last success is at least this old. */
    intervalSeconds: number;
    leaseSeconds?: number;
}

/**
 * Claims the deep repair when it is due — it never succeeded, or last succeeded at least
 * `intervalSeconds` ago — and no instance holds a lease younger than `leaseSeconds`. One statement,
 * so of two instances asking at once exactly one gets `true`: PostgreSQL holds the second on the row
 * the first updated, then evaluates the condition again against it.
 */
export async function claimDeepRepair(opts: DeepRepairScheduleOptions): Promise<boolean> {
    const now = opts.now ?? nowSec();
    const lease = opts.leaseSeconds ?? DEEP_REPAIR_LEASE_SECONDS;
    const claimed = await db
        .insert(gcRuns)
        .values({ job: DEEP_REPAIR_JOB, last_started_at: now, last_success_at: null })
        .onConflictDoUpdate({
            target: gcRuns.job,
            set: { last_started_at: now },
            setWhere: sql`${gcRuns.last_started_at} <= ${now - lease} AND (${gcRuns.last_success_at} IS NULL OR ${gcRuns.last_success_at} <= ${now - opts.intervalSeconds})`,
        })
        .returning({ job: gcRuns.job });
    return claimed.length > 0;
}

/**
 * The deep repair's place in the GC tick: runs it when it is due and this instance claims it, then
 * records the success. Returns null when it was not due or another instance holds it. A failure
 * throws and leaves `last_success_at` as it was; the lease spaces the next try.
 */
export async function runDeepRepairIfDue(
    opts: DeepRepairScheduleOptions & { repair?: () => Promise<DeepRepairResult> },
): Promise<DeepRepairResult | null> {
    const now = opts.now ?? nowSec();
    if (!(await claimDeepRepair({ ...opts, now }))) return null;
    const result = await (opts.repair ?? runDeepRepair)();
    await db.update(gcRuns).set({ last_success_at: now }).where(eq(gcRuns.job, DEEP_REPAIR_JOB));
    return result;
}
