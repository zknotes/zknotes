/**
 * Blob sweeper helpers.
 *
 * The V3 strict 1:1 model: every chunk set belongs to exactly one Item(type="file").
 * Blobs are deleted solely through the `pending_delete_at` marker — the request path never touches
 * disk or R2 directly. The async sweeper in gc.ts physically deletes the blocks only after
 * BLOB_PURGE_GRACE (1h by default), which is what gives a crop its undo window.
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "./db";
import { chunkSets } from "./db/schema";
import type { DbExecutor } from "./db/types";
import { nowSec } from "./lib/time";

/**
 * Checks that a chunk set is committed, owned by the user, NOT scheduled for deletion, and not
 * held by a restore session. Used to validate the creation and update of a file item.
 *
 * The `restore_session_id IS NULL` guard: a set a restore has staged belongs to that restore until
 * its commit clears the column. Bound by an ordinary item first, it would be deleted under that
 * item when the restore is aborted or expires.
 *
 * The `pending_delete_at IS NULL` guard: without it a new or updated item (a file conflict copy,
 * which shares chunk_set_id by design) could bind itself to a blob already scheduled for async
 * physical deletion — `markPendingDelete` is never undone anywhere, so `runGc` would really delete
 * it out from under a live reference inside the BLOB_PURGE_GRACE window.
 */
export async function chunkSetCommitted(
    chunkSetId: string,
    userId: string,
    tx: DbExecutor = db,
): Promise<boolean> {
    const rows = await tx
        .select({ id: chunkSets.id })
        .from(chunkSets)
        .where(
            and(
                eq(chunkSets.id, chunkSetId),
                eq(chunkSets.user_id, userId),
                isNull(chunkSets.pending_delete_at),
                isNull(chunkSets.restore_session_id),
            ),
        )
        .limit(1);
    return rows.length > 0;
}

/**
 * Atomically marks a chunk set for async physical deletion.
 *
 * Called on:
 *   - a file's hard delete (purged_at set)
 *   - a crop swap (the old chunk set replaced by a new one)
 *
 * Idempotent: the `pending_delete_at IS NULL` guard means a second call does not change the
 * timestamp and returns `false` (the caller must not free the quota again).
 * The request path never deletes from disk or R2 directly — that is the async sweeper in gc.ts.
 *
 * @returns true if this call is the one that set pending_delete_at
 */
export async function markPendingDelete(
    chunkSetId: string | null | undefined,
    userId: string,
    tx: DbExecutor = db,
): Promise<boolean> {
    if (!chunkSetId) return false;
    const updated = await tx
        .update(chunkSets)
        .set({ pending_delete_at: nowSec() })
        .where(
            and(
                eq(chunkSets.id, chunkSetId),
                eq(chunkSets.user_id, userId),
                isNull(chunkSets.pending_delete_at),
            ),
        )
        .returning({ id: chunkSets.id });
    return updated.length > 0;
}

/**
 * A file conflict copy shares its chunk set with the original. When the original is
 * purged, the set gets a `pending_delete_at` and `chunkSetCommitted` would reject the new item. If
 * the row still exists (GC has not physically deleted the blob), a new live ref may "bring the set
 * back" — clear pending_delete.
 *
 * A set a restore staged is never brought back this way: it belongs to that restore, and an
 * aborted restore's GC pass releases it once more — clearing the mark here (on the way to a 409)
 * would make that a second release of its quota.
 *
 * @returns true if pending_delete_at was really cleared (the caller may re-charge the files quota)
 */
export async function reclaimChunkSetFromPendingDelete(
    chunkSetId: string | null | undefined,
    userId: string,
    tx: DbExecutor = db,
): Promise<boolean> {
    if (!chunkSetId) return false;
    const updated = await tx
        .update(chunkSets)
        .set({ pending_delete_at: null })
        .where(
            and(
                eq(chunkSets.id, chunkSetId),
                eq(chunkSets.user_id, userId),
                isNotNull(chunkSets.pending_delete_at),
                isNull(chunkSets.restore_session_id),
            ),
        )
        .returning({ id: chunkSets.id });
    return updated.length > 0;
}
