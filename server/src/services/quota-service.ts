import { envPositiveNumber } from "../lib/env";
import { BACKSTOP_FACTOR, FILE_LIMITS, ITEM_LIMITS } from "@zknotes/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { chunkSets, items, users } from "../db/schema";
import type { DbExecutor } from "../db/types";

/**
 * The hard limit (quota × backstop factor) would be crossed. A class, so callers match it with
 * `instanceof` instead of comparing `err.name` strings, and so the global error handler could map
 * it by `statusCode`.
 */
export class QuotaExceededError extends Error {
    readonly statusCode = 413;
    constructor() {
        super("hard_limit_exceeded");
        this.name = "QuotaExceededError";
    }
}

/**
 * A helper structure for tracking changes across the four quota categories (bytes).
 */
export type QuotaDeltas = {
    files?: number;
    items?: number;
    history?: number;
    trash?: number;
};

/**
 * The item-count ceiling. The value is a shared constant (`ITEM_LIMITS.MAX_ITEMS_COUNT`);
 * `MAX_ITEMS_COUNT` in the environment is only an override for ops and tests, not a second source
 * of truth. It is read per call so a test can lower the ceiling without restarting the process.
 */
export function maxItemsCount(): number {
    return envPositiveNumber("MAX_ITEMS_COUNT", ITEM_LIMITS.MAX_ITEMS_COUNT);
}

/** The live-file ceiling. The ENV override is for ops and tests only, with the same semantics as maxItemsCount. */
export function maxFileCount(): number {
    return envPositiveNumber("MAX_FILE_COUNT", FILE_LIMITS.MAX_FILE_COUNT);
}

/** A user's total item count (notes + folders + files, Trash included). */
export async function countUserItems(tx: DbExecutor, userId: string): Promise<number> {
    const [result] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(items)
        .where(eq(items.user_id, userId));
    return result?.count ?? 0;
}

/**
 * Checks a user's item count plus a delta. Returns true if it would cross the ceiling (the check
 * happens only when CREATING new items).
 *
 * `knownCount` is optional for the same reason as `knownFileCount` in `item-service`: the batch
 * create loop counts ONCE and then increments locally, instead of an N+1 COUNT per item.
 */
export async function itemCountExceeded(
    tx: DbExecutor,
    userId: string,
    deltaCount: number,
    knownCount?: number,
): Promise<boolean> {
    if (deltaCount <= 0) return false;

    const currentCount = knownCount ?? (await countUserItems(tx, userId));
    return currentCount + deltaCount > maxItemsCount();
}

/**
 * Accumulates quota deltas across many `updateQuotaTx` calls inside a single caller-held
 * transaction, so the caller can take the `users` row lock ONCE (`beginQuotaAccumulator`) instead
 * of once per call, and flush the final tallies with a single `UPDATE` (`commitQuotaAccumulator`).
 * `POST /items/batch` already runs its whole handler in one transaction, so the row lock is held
 * for the same duration either way — the accumulator only removes the redundant SELECT FOR UPDATE
 * + UPDATE round trips, not a lock acquisition.
 */
export interface QuotaAccumulator {
    files: number;
    items: number;
    history: number;
    trash: number;
    quota: number;
    total_used: number; // the ORIGINAL total_used at lock time — used for the "only reject if newTotal > original total_used" comparison, exactly like the non-accumulator path.
    dirty: boolean;
}

/** The four counters plus the quota, read under `FOR UPDATE` — every quota write goes through this lock. */
async function lockUserQuotaRow(tx: DbExecutor, userId: string) {
    const [user] = await tx
        .select({
            storage_quota: users.storage_quota,
            used_files: users.storage_used_files,
            used_items: users.storage_used_items,
            used_history: users.storage_used_history,
            used_trash: users.storage_used_trash,
            total_used: users.storage_used,
        })
        .from(users)
        .where(eq(users.id, userId))
        .for("update")
        .limit(1);
    return user;
}

/** Locks the `users` row once and seeds an in-memory accumulator for `updateQuotaTx` to fold into. */
export async function beginQuotaAccumulator(
    tx: DbExecutor,
    userId: string,
): Promise<QuotaAccumulator> {
    const user = await lockUserQuotaRow(tx, userId);
    if (!user) throw new Error("User not found for quota update");
    return {
        files: user.used_files,
        items: user.used_items,
        history: user.used_history,
        trash: user.used_trash,
        quota: user.storage_quota,
        total_used: user.total_used ?? 0,
        dirty: false,
    };
}

/** Flushes an accumulator's final tallies with a single `UPDATE` — a no-op if nothing changed. */
export async function commitQuotaAccumulator(
    tx: DbExecutor,
    userId: string,
    acc: QuotaAccumulator,
): Promise<void> {
    if (!acc.dirty) return;
    await tx
        .update(users)
        .set({
            storage_used_files: acc.files,
            storage_used_items: acc.items,
            storage_used_history: acc.history,
            storage_used_trash: acc.trash,
        })
        .where(eq(users.id, userId));
}

/**
 * The main function for atomically updating the four storage counters inside a transaction.
 * It takes a row-level lock (`FOR UPDATE`) on the `users` table to prevent race conditions.
 *
 * @param tx A Drizzle transaction
 * @param userId The user's ID
 * @param deltas The changes (positive or negative) for each of the four categories.
 * @param enforceStrictLimit If true, the function throws (rolling back) when the total quota would
 *                           cross the allowed limit (backstop factor included).
 * @param opts.peakFactor A named exception for restore staging: used instead of
 *                        BACKSTOP_FACTOR. It applies only while the caller holds an open restore
 *                        session.
 * @param opts.accumulator When provided (POST /items/batch), fold the delta into the caller's
 *                        already-locked in-memory tallies instead of taking a fresh row lock —
 *                        the DB write is deferred to `commitQuotaAccumulator`.
 */
export async function updateQuotaTx(
    tx: DbExecutor,
    userId: string,
    deltas: QuotaDeltas,
    enforceStrictLimit: boolean = true,
    opts?: { peakFactor?: number; accumulator?: QuotaAccumulator },
): Promise<void> {
    const dFiles = deltas.files ?? 0;
    const dItems = deltas.items ?? 0;
    const dHistory = deltas.history ?? 0;
    const dTrash = deltas.trash ?? 0;

    if (dFiles === 0 && dItems === 0 && dHistory === 0 && dTrash === 0) return;

    if (opts?.accumulator) {
        const acc = opts.accumulator;
        const newFiles = Math.max(0, acc.files + dFiles);
        const newItems = Math.max(0, acc.items + dItems);
        const newHistory = Math.max(0, acc.history + dHistory);
        const newTrash = Math.max(0, acc.trash + dTrash);
        const newTotal = newFiles + newItems + newHistory + newTrash;

        if (enforceStrictLimit) {
            const factor = opts?.peakFactor ?? BACKSTOP_FACTOR;
            const hardLimit = acc.quota * factor;
            if (newTotal > hardLimit && newTotal > acc.total_used) {
                throw new QuotaExceededError();
            }
        }

        acc.files = newFiles;
        acc.items = newItems;
        acc.history = newHistory;
        acc.trash = newTrash;
        acc.dirty = true;
        return;
    }

    // Lock the user row for the update
    const user = await lockUserQuotaRow(tx, userId);

    if (!user) throw new Error("User not found for quota update");

    const newFiles = Math.max(0, user.used_files + dFiles);
    const newItems = Math.max(0, user.used_items + dItems);
    const newHistory = Math.max(0, user.used_history + dHistory);
    const newTrash = Math.max(0, user.used_trash + dTrash);

    const newTotal = newFiles + newItems + newHistory + newTrash;

    if (enforceStrictLimit) {
        const factor = opts?.peakFactor ?? BACKSTOP_FACTOR;
        const hardLimit = user.storage_quota * factor;
        if (newTotal > hardLimit && newTotal > (user.total_used ?? 0)) {
            throw new QuotaExceededError();
        }
    }

    await tx
        .update(users)
        .set({
            storage_used_files: newFiles,
            storage_used_items: newItems,
            storage_used_history: newHistory,
            storage_used_trash: newTrash,
        })
        .where(eq(users.id, userId));
}

/**
 * Computes an item payload's size in bytes (the plaintext overhead is the client's concern).
 * It accounts for encrypted_payload, encrypted_item_key, payload_nonce and item_key_nonce.
 */
export function getItemStorageSize(item: {
    encrypted_payload?: Buffer | string | null;
    encrypted_item_key?: Buffer | string | null;
    payload_nonce?: Buffer | string | null;
    item_key_nonce?: Buffer | string | null;
}): number {
    let size = 0;
    if (item.encrypted_payload)
        size +=
            typeof item.encrypted_payload === "string"
                ? Buffer.byteLength(item.encrypted_payload, "base64")
                : item.encrypted_payload.length;
    if (item.encrypted_item_key)
        size +=
            typeof item.encrypted_item_key === "string"
                ? Buffer.byteLength(item.encrypted_item_key, "base64")
                : item.encrypted_item_key.length;
    if (item.payload_nonce)
        size +=
            typeof item.payload_nonce === "string"
                ? Buffer.byteLength(item.payload_nonce, "base64")
                : item.payload_nonce.length;
    if (item.item_key_nonce)
        size +=
            typeof item.item_key_nonce === "string"
                ? Buffer.byteLength(item.item_key_nonce, "base64")
                : item.item_key_nonce.length;
    return size;
}

/** The four reconstructed counters of one user. */
export interface RecomputedQuota {
    files: number;
    items: number;
    history: number;
    trash: number;
}

// The byte size of an item row's four ciphertext columns, as SQL — the same arithmetic as
// `getItemStorageSize` applied in the database.
const itemBytesSql = sql`COALESCE(SUM(
    COALESCE(octet_length(encrypted_payload), 0) +
    COALESCE(octet_length(encrypted_item_key), 0) +
    COALESCE(octet_length(payload_nonce), 0) +
    COALESCE(octet_length(item_key_nonce), 0)
), 0)::bigint`;

const sumOf = (rows: Array<Record<string, unknown>>): number => Number(rows[0]?.sum ?? 0);

/**
 * Rebuilds the four storage counters of one user from the rows themselves and writes them — the one
 * definition of what belongs in which bucket. The weekly deep repair (`gc.ts`) and the operator's
 * backfill script both call it; they used to carry the same seven queries each, with a comment asking
 * that the two copies be kept identical.
 *
 *  - files:   committed blobs referenced by a live, non-trashed item, plus the bytes reserved by
 *             in-flight uploads and open restore staging (so a reconcile never loses a reservation);
 *  - items:   payload bytes of live, non-trashed items;
 *  - history: payload bytes of every history snapshot;
 *  - trash:   blobs of trashed files AND the payload bytes of trashed items — a soft delete keeps
 *             the ciphertext, so those bytes stay in a counter (otherwise this repair would "fix"
 *             the quota back to an old, wrong value every week).
 */
export async function recomputeUserQuota(
    exec: DbExecutor,
    userId: string,
): Promise<RecomputedQuota> {
    const liveBlobs = await exec.execute(sql`
        SELECT COALESCE(SUM(cs.total_size), 0)::bigint as sum
        FROM chunk_sets cs
        WHERE cs.user_id = ${userId}
          AND cs.pending_delete_at IS NULL
          AND EXISTS (
              SELECT 1 FROM items i
              WHERE i.chunk_set_id = cs.id
                AND i.user_id = cs.user_id
                AND i.deleted_at IS NULL
                AND i.purged_at IS NULL
          )
    `);
    const uploads = await exec.execute(sql`
        SELECT COALESCE(SUM(total_size), 0)::bigint as sum
        FROM upload_sessions
        WHERE user_id = ${userId} AND status IN ('uploading', 'restore_staging')
    `);
    const restoreSets = await exec.execute(sql`
        SELECT COALESCE(SUM(cs.total_size), 0)::bigint as sum
        FROM chunk_sets cs
        WHERE cs.user_id = ${userId}
          AND cs.pending_delete_at IS NULL
          AND EXISTS (
              SELECT 1 FROM restore_sessions rs
              WHERE rs.id = cs.restore_session_id
                AND rs.status = 'open'
          )
    `);
    const liveItems = await exec.execute(sql`
        SELECT ${itemBytesSql} as sum
        FROM items
        WHERE user_id = ${userId}
          AND deleted_at IS NULL
          AND purged_at IS NULL
          AND encrypted_payload IS NOT NULL
    `);
    const history = await exec.execute(sql`
        SELECT ${itemBytesSql} as sum
        FROM item_history
        WHERE user_id = ${userId}
    `);
    const trashedBlobs = await exec.execute(sql`
        SELECT COALESCE(SUM(cs.total_size), 0)::bigint as sum
        FROM chunk_sets cs
        WHERE cs.user_id = ${userId}
          AND cs.pending_delete_at IS NULL
          AND EXISTS (
              SELECT 1 FROM items i
              WHERE i.chunk_set_id = cs.id
                AND i.user_id = cs.user_id
                AND i.deleted_at IS NOT NULL
                AND i.purged_at IS NULL
          )
    `);
    const trashedItems = await exec.execute(sql`
        SELECT ${itemBytesSql} as sum
        FROM items
        WHERE user_id = ${userId}
          AND deleted_at IS NOT NULL
          AND purged_at IS NULL
          AND encrypted_payload IS NOT NULL
    `);

    const result: RecomputedQuota = {
        files: sumOf([...liveBlobs]) + sumOf([...uploads]) + sumOf([...restoreSets]),
        items: sumOf([...liveItems]),
        history: sumOf([...history]),
        trash: sumOf([...trashedBlobs]) + sumOf([...trashedItems]),
    };

    await exec
        .update(users)
        .set({
            storage_used_files: result.files,
            storage_used_items: result.items,
            storage_used_history: result.history,
            storage_used_trash: result.trash,
        })
        .where(eq(users.id, userId));

    return result;
}
