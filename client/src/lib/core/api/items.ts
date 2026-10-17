// The domain client for the /items endpoints — the batch push and the delta pull.
// The sync semantics (a conflict copy, the backoff, the watermark) stay in core/sync.
import { type DeleteId, type EncryptedItem, SYNC_LIMITS } from "@zknotes/shared";
import { apiFetch } from "./client";

export interface PushBatchResult {
    succeeded: { id: string; version: number; updated_at: number; created_at: number }[];
    conflicts: { id: string; current_item: EncryptedItem & { user_id?: string } }[];
    errors?: { id: string; error?: string }[];
}

export interface PullDelta {
    items: (EncryptedItem & { user_id?: string })[];
    /** Hard-delete the entries from sync_deleted_log. */
    deleted?: { id: string; deleted_at: number }[];
    server_time: number;
    /** Present only when the client sent a `limit`. `null` = the last page. */
    next_cursor?: string | null;
}

/**
 * POST /items/batch — an idempotent, version-checked upsert + soft/hard delete.
 *
 * A `deleteIds` entry may be a bare id (an unconditional purge) or `{ id, version }` (a
 * version-guarded purge — the server purges only when the version matches, which guards against the
 * stale-delete race).
 */
export async function pushBatch(
    upsert: EncryptedItem[],
    deleteIds: DeleteId[] = [],
): Promise<PushBatchResult> {
    return apiFetch("/items/batch", {
        method: "POST",
        body: JSON.stringify({ upsert, delete_ids: deleteIds }),
    });
}

/** One page of `GET /items`. The server requires `limit`; a pull follows `next_cursor` until it is null. */
export async function pullPage(opts: {
    since: number;
    cursor?: string | null;
    limit?: number;
}): Promise<PullDelta> {
    const limit = opts.limit ?? SYNC_LIMITS.PULL_PAGE_SIZE;
    const params = new URLSearchParams({
        since: String(opts.since),
        limit: String(limit),
    });
    if (opts.cursor) params.set("cursor", opts.cursor);
    return apiFetch(`/items?${params.toString()}`);
}

/** GET /items?since= — the delta pull; server_time moves the sync watermark. */
export async function pullSince(watermark: number): Promise<PullDelta> {
    return pullPage({ since: watermark });
}
