// History business logic lifted out of routes/history.ts: the tiered thin-out and the
// ROW_NUMBER snapshot queries (previously duplicated between the GET list and the GET single).
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, pgClient } from "../db";
import { HISTORY_HARD_CAP, itemHistory } from "../db/schema";
import { nowSec } from "../lib/time";

export interface NumberedSnapshotRow {
    id: string;
    item_id: string;
    encrypted_payload: Buffer;
    payload_nonce: Buffer;
    encrypted_item_key: Buffer;
    item_key_nonce: Buffer;
    item_version_at_snapshot: number;
    created_at: number;
    snapshot_number: number;
}

// ROW_NUMBER is computed over ALL snapshots of this item, not just the page, so the numbers stay
// stable across pages.
const numberedCte = (itemId: string, userId: string) => pgClient`
    SELECT *,
        ROW_NUMBER() OVER (ORDER BY created_at ASC)::integer AS snapshot_number
    FROM item_history
    WHERE item_id = ${itemId} AND user_id = ${userId}
`;

/** A page of snapshots (DESC by created_at); beforeSec filters AFTER the numbering. */
export async function listNumberedSnapshots(
    itemId: string,
    userId: string,
    opts: { limit: number; beforeSec: number | null },
): Promise<NumberedSnapshotRow[]> {
    return pgClient<NumberedSnapshotRow[]>`
        WITH numbered AS (${numberedCte(itemId, userId)})
        SELECT * FROM numbered
        WHERE (${opts.beforeSec}::bigint IS NULL OR created_at < ${opts.beforeSec})
        ORDER BY created_at DESC
        LIMIT ${opts.limit}
    `;
}

/** One snapshot, with the same stable snapshot_number as in the list. */
export async function getNumberedSnapshot(
    itemId: string,
    userId: string,
    snapshotId: string,
): Promise<NumberedSnapshotRow | undefined> {
    const [row] = await pgClient<NumberedSnapshotRow[]>`
        WITH numbered AS (${numberedCte(itemId, userId)})
        SELECT * FROM numbered WHERE id = ${snapshotId}
    `;
    return row;
}

import type { DbExecutor } from "../db/types";
/**
 * Tiered thin-out: after a new snapshot is inserted, delete old ones so that a useful
 * span of history fits inside the hard cap of 50 snapshots:
 *   - the last 24 h → every snapshot
 *   - 1–30 days → at most 1/day (keep the newest of each day)
 *   - >30 days  → at most 1/week (keep the newest of each week)
 *
 * It runs inline on every POST — no background job is needed.
 */
import { getItemStorageSize } from "./quota-service";

export async function thinOut(tx: DbExecutor, itemId: string, userId: string): Promise<number> {
    const all = await tx
        .select({ id: itemHistory.id, created_at: itemHistory.created_at })
        .from(itemHistory)
        .where(and(eq(itemHistory.item_id, itemId), eq(itemHistory.user_id, userId)))
        .orderBy(desc(itemHistory.created_at));

    if (all.length <= 1) return 0;

    const now = nowSec();
    const DAY = 86400;
    const WEEK = 7 * DAY;
    const cutoff24h = now - DAY;
    const cutoff30d = now - 30 * DAY;

    const toDelete = new Set<string>();

    // Group entries older than 24 h into buckets (daily or weekly) and keep only the newest per bucket.
    const seenDayBuckets = new Map<number, string>(); // bucket → the id of the newest one we keep
    const seenWeekBuckets = new Map<number, string>();

    for (const row of all) {
        if (row.created_at >= cutoff24h) continue; // keep everything recent

        if (row.created_at >= cutoff30d) {
            const bucket = Math.floor(row.created_at / DAY);
            const existing = seenDayBuckets.get(bucket);
            if (existing === undefined) {
                seenDayBuckets.set(bucket, row.id);
            } else {
                // this row is older (DESC order) — mark it for deletion
                toDelete.add(row.id);
            }
        } else {
            const bucket = Math.floor(row.created_at / WEEK);
            const existing = seenWeekBuckets.get(bucket);
            if (existing === undefined) {
                seenWeekBuckets.set(bucket, row.id);
            } else {
                toDelete.add(row.id);
            }
        }
    }

    // Also enforce the hard cap on whatever survives the tier pruning (FIFO, oldest first).
    const surviving = all.filter((r) => !toDelete.has(r.id));
    if (surviving.length > HISTORY_HARD_CAP) {
        const excess = surviving.slice(HISTORY_HARD_CAP); // the oldest are at the end (DESC sort)
        for (const r of excess) toDelete.add(r.id);
    }

    if (toDelete.size === 0) return 0;

    const deleted = await tx
        .delete(itemHistory)
        .where(
            and(
                inArray(itemHistory.id, [...toDelete]),
                eq(itemHistory.user_id, userId), // ownership guard
            ),
        )
        .returning();

    let deletedSize = 0;
    for (const r of deleted) {
        deletedSize += getItemStorageSize(r);
    }
    return deletedSize;
}
