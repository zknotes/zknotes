// Shared upload/purge logic — one source of truth for aborting in-flight uploads and for deleting
// a user completely. Called by self-delete (purgeUserData) and by an extension that locks or
// deletes users.
//
// Before this: abort was a local function in routes/files.ts (one chunkSetId), and self-delete did a
// bare `db.delete(users)` (an S3 leak — it neither marked chunk_sets nor cleaned up file_chunks).
import { updateQuotaTx } from "./quota-service";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chunkSets, fileChunks, uploadSessions, users } from "../db/schema";
import type { DbTransaction } from "../db/types";
import { nowSec } from "../lib/time";

/**
 * Aborts ALL of a user's in-flight ("uploading") upload sessions inside the given transaction:
 *  1. releases the reserved `storage_used` (Σ total_size, with a GREATEST(0, …) guard),
 *  2. deletes their `file_chunks` rows,
 *  3. sets `status='aborted'` (which kills `finalize` — a committed session never becomes a live
 *     file).
 *
 * Aborted and committed sessions are left alone (idempotent: a retry does not free the quota
 * twice). The in-flight S3 prefix (`u/{userId}/{uploadSessionId}/`) is caught by the GC deep-repair
 * (a prefix with no DB record).
 */
export async function abortAllUserUploads(tx: DbTransaction, userId: string): Promise<void> {
    const uploading = await tx
        .select({ id: uploadSessions.id, total_size: uploadSessions.total_size })
        .from(uploadSessions)
        .where(and(eq(uploadSessions.user_id, userId), eq(uploadSessions.status, "uploading")));

    if (uploading.length === 0) return;

    const reserved = uploading.reduce((sum, s) => sum + s.total_size, 0);
    const ids = uploading.map((s) => s.id);

    // The reservation leaves the files bucket through the quota service, like every other release.
    await updateQuotaTx(tx, userId, { files: -reserved }, false);

    await tx.delete(fileChunks).where(inArray(fileChunks.chunk_set_id, ids));

    await tx
        .update(uploadSessions)
        .set({ status: "aborted", updated_at: nowSec() })
        .where(and(eq(uploadSessions.user_id, userId), eq(uploadSessions.status, "uploading")));
}

/**
 * Deleting a user completely — the shared path for a self-delete and an extension's DELETE (one
 * source of truth). Everything happens inside the given transaction; the audit entry and the optimistic check
 * are the CALLER's responsibility (the route).
 *
 * The steps (order matters):
 *  1. abort in-flight uploads (release the reservation, delete their file_chunks),
 *  2. mark committed chunk sets `pending_delete_at` — GC physically deletes the blobs only after
 *     BLOB_PURGE_GRACE; the `chunk_sets` row DELIBERATELY survives (it has no FK to users) because
 *     GC needs it as the record of "what to clean up in S3",
 *  3. explicitly delete ALL of the user's `file_chunks` (no FK to users → CASCADE does not touch
 *     them),
 *  4. delete the `users` row — this cascades to items, sessions, upload_sessions,
 *     sync_deleted_log and item_history (all with onDelete:"cascade").
 */
export async function purgeUserData(tx: DbTransaction, userId: string): Promise<void> {
    await abortAllUserUploads(tx, userId);

    await tx
        .update(chunkSets)
        .set({ pending_delete_at: nowSec() })
        .where(and(eq(chunkSets.user_id, userId), sql`${chunkSets.pending_delete_at} IS NULL`));

    await tx.delete(fileChunks).where(eq(fileChunks.user_id, userId));

    await tx.delete(users).where(eq(users.id, userId));
}
