// Item business logic lifted out of routes/items.ts — the route files are pure transport.
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
    chunkSetCommitted,
    markPendingDelete,
    reclaimChunkSetFromPendingDelete,
} from "../blob-sweeper";
import { db } from "../db";
import { chunkSets, itemHistory, items, syncDeletedLog, users } from "../db/schema";
import type { DbExecutor } from "../db/types";
import { clampDeletedAt, nowSec } from "../lib/time";
import { wireBlobsToRow } from "../lib/wire";
import {
    getItemStorageSize,
    maxFileCount,
    type QuotaAccumulator,
    QuotaExceededError,
    updateQuotaTx,
} from "./quota-service";

/** The ciphertext bytes of history rows — the one SQL expression for the history quota. */
const historyBytesSql = sql<number>`SUM(LENGTH(${itemHistory.encrypted_payload}) + LENGTH(${itemHistory.payload_nonce}) + LENGTH(${itemHistory.encrypted_item_key}) + LENGTH(${itemHistory.item_key_nonce}))`;

/**
 * Why a parent cannot take this child, or null when it can. A purged parent is gone; a trashed
 * parent takes only a child that arrives trashed too (a synced cascade), otherwise a READY child
 * under it would be an orphan path; a file hangs under a note, everything else under a folder.
 * POST, PUT and the batch used to spell these three answers out each.
 */
export function parentRejection(
    parent: { type: string; deleted_at: number | null; purged_at: number | null } | undefined,
    childType: string,
    childTrashed: boolean,
): string | null {
    if (!parent || parent.purged_at != null || (parent.deleted_at != null && !childTrashed)) {
        return "Parent not found";
    }
    if (childType === "file" && parent.type !== "note") return "File parent must be a note";
    if (childType !== "file" && parent.type !== "folder") return "Parent is not a folder";
    return null;
}

/**
 * The quota movement of READY → TRASHED: the payload bytes change bucket (`items` → `trash`), and
 * so does the blob when no other live item still references the chunk set. `chunkSetSize` is read
 * only when that is the case (the batch answers from its prefetched map, DELETE asks the database).
 */
export async function trashTransitionDeltas(
    tx: DbExecutor,
    item: { id: string; chunk_set_id: string | null },
    userId: string,
    payloadSize: number,
    chunkSetSize: (chunkSetId: string) => Promise<number | undefined>,
): Promise<{ items: number; files: number; trash: number }> {
    const deltas = { items: -payloadSize, files: 0, trash: payloadSize };
    if (
        item.chunk_set_id &&
        !(await hasOtherLiveChunkSetRef(tx, item.chunk_set_id, userId, item.id))
    ) {
        const size = await chunkSetSize(item.chunk_set_id);
        if (size) {
            deltas.files -= size;
            deltas.trash += size;
        }
    }
    return deltas;
}

type ItemRow = typeof items.$inferSelect;

/**
 * Release a chunk set (pending_delete + storage_used) only when no other non-purged item references
 * it — one source of truth for the purge and crop-swap paths (conflict copies share a set).
 *
 * The quota is freed ONLY when markPendingDelete really moves NULL → timestamp
 * (a second call, or an already-pending set, is a no-op with no double free).
 */
export async function releaseChunkSetIfUnreferenced(
    tx: DbExecutor,
    chunkSetId: string,
    userId: string,
    excludeItemId?: string,
    opts?: {
        accumulator?: QuotaAccumulator;
        /**
         * The bucket the set's bytes are counted in, when the caller knows it. Otherwise it is
         * read from an item that references the set — which a caller that has just pointed that
         * item elsewhere (a restore overwrite) no longer has.
         */
        bucket?: "files" | "trash";
    },
): Promise<void> {
    const refConditions = [
        eq(items.chunk_set_id, chunkSetId),
        eq(items.user_id, userId),
        isNull(items.purged_at),
    ];
    if (excludeItemId) refConditions.push(ne(items.id, excludeItemId));

    const [stillReferenced] = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(...refConditions))
        .limit(1);

    if (stillReferenced) return;

    // Read the size and trash state BEFORE the mark (the row still exists after it).
    const [cs] = await tx
        .select({ total_size: chunkSets.total_size })
        .from(chunkSets)
        .where(eq(chunkSets.id, chunkSetId))
        .limit(1);
    if (!cs) return;

    const marked = await markPendingDelete(chunkSetId, userId, tx);
    if (!marked) return; // already pending, or someone else's / nonexistent set — do not free the quota again

    if (cs.total_size) {
        let inTrash = opts?.bucket === "trash";
        if (opts?.bucket === undefined) {
            const [item] = await tx
                .select({ deleted_at: items.deleted_at })
                .from(items)
                .where(eq(items.chunk_set_id, chunkSetId))
                .limit(1);
            inTrash = item?.deleted_at != null;
        }
        await updateQuotaTx(
            tx,
            userId,
            inTrash ? { trash: -Number(cs.total_size) } : { files: -Number(cs.total_size) },
            false,
            { accumulator: opts?.accumulator },
        );
    }
}

/**
 * Checks whether any other (non-purged) item still references the same chunk_set_id in a LIVE
 * (non-trashed) state. This is the only condition under which the files↔trash buckets may move a
 * shared chunk set's quota (a shared set — a file plus a conflict copy — used to move the quota
 * twice once BOTH referencing items went through trash/restore, because each of them moved the full
 * byte count independently).
 *
 * Invariant: a chunk set's bytes are counted in EXACTLY one bucket — `files` if at least one live
 * item references it, otherwise `trash`. The delta is applied only on a transition of that bucket
 * (the last live item being trashed, or the first being restored) — the check is identical in both
 * directions.
 */
export async function hasOtherLiveChunkSetRef(
    tx: DbExecutor,
    chunkSetId: string,
    userId: string,
    excludeItemId: string,
): Promise<boolean> {
    const [row] = await tx
        .select({ id: items.id })
        .from(items)
        .where(
            and(
                eq(items.chunk_set_id, chunkSetId),
                eq(items.user_id, userId),
                isNull(items.purged_at),
                isNull(items.deleted_at),
                ne(items.id, excludeItemId),
            ),
        )
        .limit(1);
    return !!row;
}

/** Only a file item may carry a chunk set; an item without one binds nothing. */
export function fileSetBindable(type: string, chunkSetId: string | null | undefined): boolean {
    return !chunkSetId || type === "file";
}

export type BindFileSetOutcome =
    | { ok: true; reclaimedBytes: number }
    | { ok: false; status: 409 | 413; error: string };

/**
 * Binds a chunk set to a file item: a committed, user-owned set is simply accepted. A set in
 * `pending_delete` (its original was purged, the blob still exists — a conflict copy shares it) is
 * brought back AND its bytes are charged to the files bucket again, because `releaseChunkSetIfUnreferenced`
 * freed them when the original went. Create and both update paths call this; the update paths used to
 * reclaim through a predicate with a side effect and never re-charged, leaving an undercount until the
 * weekly deep repair. On the hard limit the pending mark is restored so no live set is left without an item.
 */
export async function bindFileSet(
    exec: DbExecutor,
    userId: string,
    chunkSetId: string,
    opts?: { accumulator?: QuotaAccumulator },
): Promise<BindFileSetOutcome> {
    if (await chunkSetCommitted(chunkSetId, userId, exec)) return { ok: true, reclaimedBytes: 0 };

    const reclaimed = await reclaimChunkSetFromPendingDelete(chunkSetId, userId, exec);
    if (!reclaimed || !(await chunkSetCommitted(chunkSetId, userId, exec))) {
        return { ok: false, status: 409, error: "Referenced chunk set is not committed" };
    }

    const [cs] = await exec
        .select({ total_size: chunkSets.total_size })
        .from(chunkSets)
        .where(eq(chunkSets.id, chunkSetId))
        .limit(1);
    const bytes = Number(cs?.total_size ?? 0);
    if (bytes > 0) {
        try {
            await updateQuotaTx(exec, userId, { files: bytes }, true, {
                accumulator: opts?.accumulator,
            });
        } catch (e) {
            if (e instanceof QuotaExceededError) {
                await markPendingDelete(chunkSetId, userId, exec);
                return { ok: false, status: 413, error: "hard_limit_exceeded" };
            }
            throw e;
        }
    }
    return { ok: true, reclaimedBytes: bytes };
}

/**
 * Hard delete (purge) of one item inside a transaction — one source of truth for all three paths
 * (DELETE /items/:id/purge, POST /items/batch delete_ids):
 *   1. blob → pending_delete (async sweeper) + release the storage_used
 *      quota — only once no other non-purged item references the set (a conflict copy shares it)
 *   2. items row → tombstone (purged_at set, every encrypted column and chunk ref nulled)
 *   3. write a row into sync_deleted_log — the long-term delta-sync signal
 *      "this was deleted"; onConflictDoNothing makes a retry idempotent
 */
export async function purgeItemTx(
    tx: DbExecutor,
    current: {
        id: string;
        version: number;
        chunk_set_id: string | null;
        deleted_at?: number | null;
        encrypted_payload?: Buffer | string | null;
        encrypted_item_key?: Buffer | string | null;
        payload_nonce?: Buffer | string | null;
        item_key_nonce?: Buffer | string | null;
    },
    userId: string,
    nowTs: number,
    opts?: { accumulator?: QuotaAccumulator },
): Promise<void> {
    // Permanently deleting a note that has history must first sum the size of its
    // snapshots in item_history and explicitly reduce storage_used_history.
    const historyRows = await tx
        .select({ ciphertext_size: historyBytesSql })
        .from(itemHistory)
        .where(and(eq(itemHistory.item_id, current.id), eq(itemHistory.user_id, userId)));

    const histSize = Number(historyRows[0]?.ciphertext_size ?? 0);
    if (histSize > 0) {
        await updateQuotaTx(tx, userId, { history: -histSize }, false, {
            accumulator: opts?.accumulator,
        });
    }

    // ...and then actually delete them. The quota was refunded from the very beginning, but the rows
    // were left behind: `item_history.item_id` cascades from `items`, and a purge TOMBSTONES that row
    // rather than deleting it, so the cascade only fired when the GC swept the tombstone
    // (TOMBSTONE_PURGE_DAYS, 30 by default). Until then `GET /items/:id/history` still served every
    // snapshot of a note the user had permanently deleted — ciphertext plus an `encrypted_item_key`
    // still wrapped under the live Vault Key, so their own client could decrypt and read it back —
    // while the storage breakdown reported the bytes as freed. "Delete permanently" has to mean it.
    await tx.delete(itemHistory).where(eq(itemHistory.item_id, current.id));

    // The payload bytes now count — in `trash` if the item was in Trash, otherwise
    // in `items` (a direct hard delete of a live row through delete_ids). The purge nulls them, so
    // it has to release them too. The size is read BEFORE the UPDATE that sets the columns to null.
    // (Before that change, `items` was never subtracted on a direct purge — a silent leak.)
    const payloadSize = getItemStorageSize(current);
    if (payloadSize > 0) {
        await updateQuotaTx(
            tx,
            userId,
            current.deleted_at != null ? { trash: -payloadSize } : { items: -payloadSize },
            false,
            { accumulator: opts?.accumulator },
        );
    }

    if (current.chunk_set_id) {
        await releaseChunkSetIfUnreferenced(tx, current.chunk_set_id, userId, current.id, {
            accumulator: opts?.accumulator,
        });
    }

    await tx
        .update(items)
        .set({
            purged_at: nowTs,
            // deleted_at stays if the item was already TRASHED; for a direct hard delete we set it
            deleted_at: sql`COALESCE(${items.deleted_at}, ${nowTs})`,
            updated_at: nowTs,
            version: current.version + 1,
            // Null everything — only the tombstone remains (id, user_id, type, deleted_at, purged_at)
            encrypted_payload: null,
            payload_nonce: null,
            encrypted_item_key: null,
            item_key_nonce: null,
            chunk_set_id: null,
            chunk_count: null,
            ciphertext_size: null,
        })
        // Defence in depth: the only production caller is `purgeOwnedItem`, which already
        // holds the row locked (FOR UPDATE) and has checked its state — but the guard is free and
        // protects future callers from tombstoning an already-purged row.
        .where(and(eq(items.id, current.id), isNull(items.purged_at)));

    await tx
        .insert(syncDeletedLog)
        .values({ user_id: userId, item_id: current.id, deleted_at: nowTs })
        .onConflictDoNothing();
}

/**
 * Purge helper with ownership and optional optimistic-lock check.
 *
 * `expectedVersion` (version-aware delete): when the client sends an expected version, we purge
 * ONLY if it matches the server's current one. If the server's is newer (the item was restored from
 * Trash or edited on another device), a stale delete from an "empty trash" queue must NOT destroy
 * that work → skip the purge (return false). Without `expectedVersion` (legacy / bulk) we purge
 * unconditionally, as before.
 *
 * `opts.expiredTrashOnly` — ONLY for the retention sweep (`gc.ts` C.2). It requires
 * the row to still be TRASHED and its `deleted_at` to still be older than `cutoff`. GC picks
 * candidates with a `SELECT` OUTSIDE the transaction, so between the pick and the purge the user can
 * restore the item from Trash; this re-check on the already-locked row is the WHERE guard
 * (`deleted_at IS NOT NULL AND deleted_at < $cutoff`). Without it a restore silently loses the race
 * against the sweep.
 *
 * NOTE: the guard is deliberately **opt-in**, not global. A direct hard delete of a READY row
 * through `delete_ids` is a supported contract (see `COALESCE(deleted_at, nowTs)` in `purgeItemTx`)
 * — a user may permanently delete their own live item without it passing through Trash. The client
 * does not do that (`FileLifecycle` allows hardDelete only from TRASHED, and `permanentDeleteItem`
 * is called only from the `/trash` page), so the state guard lives on the client; the server stays
 * permissive towards the user's own data.
 */
export async function purgeOwnedItem(
    tx: DbExecutor,
    id: string,
    userId: string,
    nowTs: number,
    expectedVersion?: number,
    opts?: { expiredTrashOnly?: { cutoff: number }; accumulator?: QuotaAccumulator },
): Promise<boolean> {
    // FOR UPDATE: prevents the same item being purged twice from two devices at once
    // (this would release the chunk-set quota twice through releaseChunkSetIfUnreferenced — see getOwnedItem).
    const current = await getOwnedItem(tx, id, userId, true);
    if (!current || current.purged_at) return false;
    if (expectedVersion !== undefined && current.version !== expectedVersion) return false;
    if (opts?.expiredTrashOnly) {
        // A restore cleared deleted_at, or a restore plus a re-trash refreshed it past the cutoff →
        // the candidate has not expired any more, so skip it.
        if (current.deleted_at == null) return false;
        if (current.deleted_at > opts.expiredTrashOnly.cutoff) return false;
    }
    await purgeItemTx(tx, current, userId, nowTs, { accumulator: opts?.accumulator });
    return true;
}

/**
 * One `delete_ids` entry of `POST /items/batch`: a bare id purges unconditionally,
 * `expectedVersion` makes it version-aware.
 */
export interface BatchPurgeEntry {
    id: string;
    expectedVersion?: number;
}

export interface BatchPurgeResult {
    /** The ids THIS call tombstoned (already-purged, unknown and refused ids are not here). */
    purged: string[];
    /** Version-aware entries refused because the row is live under a different version — the route reports them as conflicts. */
    refused: ItemRow[];
}

/**
 * The batched form of `purgeOwnedItem` for `POST /items/batch delete_ids` — the same semantics
 * (`purgeItemTx` steps 1–3, the version-aware refusal, idempotence over tombstones), in a fixed
 * number of statements instead of ~8 per id. The whole batch runs inside one transaction that
 * already holds the `users` row lock (the quota accumulator), so with the per-id path an "Empty
 * trash" of a thousand items meant thousands of sequential round trips during which every other
 * write of that user (uploads, other devices' pushes, history) waited on that lock.
 *
 * Bucket rule for a released chunk set: its bytes sit in `files` while at least one live
 * (non-trashed, non-purged) item references it, otherwise in `trash` — the invariant
 * `hasOtherLiveChunkSetRef` documents. With one referencing row that is exactly the per-id
 * behaviour; with a shared set (a file plus its conflict copy) purged in the same batch
 * it releases from the bucket the bytes are actually in.
 */
export async function purgeOwnedItemsBatch(
    tx: DbExecutor,
    entries: readonly BatchPurgeEntry[],
    userId: string,
    nowTs: number,
    opts?: { accumulator?: QuotaAccumulator },
): Promise<BatchPurgeResult> {
    if (entries.length === 0) return { purged: [], refused: [] };
    const candidateIds = [...new Set(entries.map((e) => e.id))];

    // 1. Lock every candidate row in ONE statement (the FOR UPDATE `purgeOwnedItem` takes per id).
    const rows = await tx
        .select()
        .from(items)
        .where(and(eq(items.user_id, userId), inArray(items.id, candidateIds)))
        .for("update");
    const byId = new Map(rows.map((r) => [r.id, r]));

    const toPurge: ItemRow[] = [];
    const refused: ItemRow[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        // A duplicate id in one batch: the first decides, the second would have met a tombstone.
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const row = byId.get(entry.id);
        if (!row || row.purged_at != null) continue;
        if (entry.expectedVersion !== undefined && row.version !== entry.expectedVersion) {
            refused.push(row);
            continue;
        }
        toPurge.push(row);
    }
    if (toPurge.length === 0) return { purged: [], refused };
    const purgeIds = toPurge.map((r) => r.id);
    const purgeSet = new Set(purgeIds);

    // 2. History: one grouped SUM for the quota, one DELETE for the rows.
    let dHistory = 0;
    const histRows = await tx
        .select({
            item_id: itemHistory.item_id,
            bytes: historyBytesSql,
        })
        .from(itemHistory)
        .where(and(eq(itemHistory.user_id, userId), inArray(itemHistory.item_id, purgeIds)))
        .groupBy(itemHistory.item_id);
    for (const h of histRows) dHistory -= Number(h.bytes ?? 0);
    await tx.delete(itemHistory).where(inArray(itemHistory.item_id, purgeIds));

    // 3. Payload bytes leave the bucket they are in (`trash` for a trashed row, else `items`).
    let dItems = 0;
    let dTrash = 0;
    for (const row of toPurge) {
        const size = getItemStorageSize(row);
        if (row.deleted_at != null) dTrash -= size;
        else dItems -= size;
    }

    // 4. Chunk sets: release those no non-purged item OUTSIDE this purge still references.
    let dFiles = 0;
    const chunkSetIds = [
        ...new Set(toPurge.map((r) => r.chunk_set_id).filter((id): id is string => id != null)),
    ];
    if (chunkSetIds.length > 0) {
        const refs = await tx
            .select({
                chunk_set_id: items.chunk_set_id,
                id: items.id,
                deleted_at: items.deleted_at,
            })
            .from(items)
            .where(
                and(
                    eq(items.user_id, userId),
                    inArray(items.chunk_set_id, chunkSetIds),
                    isNull(items.purged_at),
                ),
            );
        const stillReferenced = new Set<string>();
        const anyLiveRef = new Set<string>();
        for (const ref of refs) {
            if (!ref.chunk_set_id) continue;
            if (!purgeSet.has(ref.id)) stillReferenced.add(ref.chunk_set_id);
            else if (ref.deleted_at == null) anyLiveRef.add(ref.chunk_set_id);
        }
        const releasable = chunkSetIds.filter((id) => !stillReferenced.has(id));
        if (releasable.length > 0) {
            // The same idempotent mark as `markPendingDelete` (a set already pending frees no quota again).
            const marked = await tx
                .update(chunkSets)
                .set({ pending_delete_at: nowTs })
                .where(
                    and(
                        inArray(chunkSets.id, releasable),
                        eq(chunkSets.user_id, userId),
                        isNull(chunkSets.pending_delete_at),
                    ),
                )
                .returning({ id: chunkSets.id, total_size: chunkSets.total_size });
            for (const cs of marked) {
                const size = Number(cs.total_size);
                if (!size) continue;
                if (anyLiveRef.has(cs.id)) dFiles -= size;
                else dTrash -= size;
            }
        }
    }

    // 5. The quota: releases only, so one call with the summed deltas equals the per-step calls.
    await updateQuotaTx(
        tx,
        userId,
        { history: dHistory, items: dItems, trash: dTrash, files: dFiles },
        false,
        { accumulator: opts?.accumulator },
    );

    // 6. Tombstone every row in ONE UPDATE (the same column set as purgeItemTx; version+1 per row).
    await tx
        .update(items)
        .set({
            purged_at: nowTs,
            deleted_at: sql`COALESCE(${items.deleted_at}, ${nowTs})`,
            updated_at: nowTs,
            version: sql`${items.version} + 1`,
            encrypted_payload: null,
            payload_nonce: null,
            encrypted_item_key: null,
            item_key_nonce: null,
            chunk_set_id: null,
            chunk_count: null,
            ciphertext_size: null,
        })
        .where(
            and(inArray(items.id, purgeIds), eq(items.user_id, userId), isNull(items.purged_at)),
        );

    // 7. The delta-sync signal in ONE INSERT; onConflictDoNothing keeps a
    // retry idempotent.
    await tx
        .insert(syncDeletedLog)
        .values(purgeIds.map((item_id) => ({ user_id: userId, item_id, deleted_at: nowTs })))
        .onConflictDoNothing();

    return { purged: purgeIds, refused };
}

/** A map of folderId → parentId for the cycle check (previously duplicated in POST and PUT /items). */
export async function buildFolderParentMap(
    userId: string,
    executor: DbExecutor = db,
): Promise<Map<string, string | null>> {
    const allFolders = await executor
        .select({ id: items.id, parent_id: items.parent_id })
        .from(items)
        .where(and(eq(items.user_id, userId), eq(items.type, "folder")));

    return new Map<string, string | null>(
        allFolders.map((f: { id: string; parent_id: string | null }) => [f.id, f.parent_id]),
    );
}

/** Counts live file items (one `COUNT(*)` per call) — used by `fileCountExceeded` when the caller
 *  has no freshly known count. */
export async function countLiveFiles(userId: string, executor: DbExecutor = db): Promise<number> {
    const [row] = await executor
        .select({ n: count() })
        .from(items)
        .where(and(eq(items.user_id, userId), eq(items.type, "file"), isNull(items.deleted_at)));
    return Number(row?.n ?? 0);
}

/**
 * Checks the live file-item limit — shared by POST /items and batch create.
 * `knownCount` is optional: the batch create loop (to avoid an N+1 COUNT per file item in the
 * batch) counts ONCE before the loop and increments locally instead of asking the database for
 * every new file item.
 */
export async function fileCountExceeded(
    userId: string,
    maxCount: number,
    executor: DbExecutor = db,
    knownCount?: number,
): Promise<boolean> {
    const n = knownCount ?? (await countLiveFiles(userId, executor));
    return n >= maxCount;
}

/** The wire item data for an insert — shared by POST /items and batch create. */
export interface NewItemData {
    id: string;
    type: "note" | "folder" | "file";
    parent_id: string | null;
    encrypted_payload?: string | null;
    payload_nonce?: string | null;
    encrypted_item_key?: string | null;
    item_key_nonce?: string | null;
    chunk_set_id?: string | null;
    chunk_count?: number | null;
    ciphertext_size?: number | null;
    sort_order: string;
    // Synced trash: an item can reach the server ALREADY trashed (an offline create plus an offline
    // trash before the first push). Without this the create branch silently returns the item to
    // READY and it "resurrects" on every other device as soon as a pull picks it up.
    deleted_at?: number | null;
    trashed_batch_id?: string | null;
}

/** Inserts a new item row (version=1) — the only create implementation. `RETURNING` yields the row without a re-select. */
export async function insertItemRow(
    executor: DbExecutor,
    userId: string,
    data: NewItemData,
): Promise<ItemRow> {
    const ts = nowSec();
    // The server clamps a future deleted_at (the same anti-abuse as update-put,
    // lib/time.ts::clampDeletedAt) — otherwise immortal trash dodges the retention sweep.
    const deletedAt = clampDeletedAt(data.deleted_at, ts);
    const [row] = await executor
        .insert(items)
        .values({
            id: data.id,
            user_id: userId,
            type: data.type,
            parent_id: data.parent_id,
            ...wireBlobsToRow(data),
            chunk_set_id: data.type === "file" ? (data.chunk_set_id ?? null) : null,
            chunk_count: data.type === "file" ? (data.chunk_count ?? null) : null,
            ciphertext_size: data.type === "file" ? (data.ciphertext_size ?? null) : null,
            sort_order: data.sort_order,
            deleted_at: deletedAt,
            trashed_batch_id: deletedAt != null ? (data.trashed_batch_id ?? null) : null,
            version: 1,
            created_at: ts,
            updated_at: ts,
        })
        .returning();
    if (!row) throw new Error("Insert failed");
    return row;
}

/** The result of the create path: a row, or an HTTP-status precondition error. */
export type CreateOutcome =
    | { kind: "created"; row: ItemRow }
    | { kind: "error"; status: 409 | 429 | 413; error: string };

/**
 * A precondition failure thrown from inside a transaction so it rolls back (the quota charge made a
 * step earlier must not survive a refused insert). Routes map it to its status. It replaces an
 * `Error("CREATE_ERROR:" + JSON)` whose message the route parsed back.
 */
export class ItemRejected extends Error {
    constructor(
        readonly status: 409 | 413 | 429,
        readonly error: string,
    ) {
        super(error);
        this.name = "ItemRejected";
    }
}

/**
 * One create path with its preconditions — shared by `POST /items` and `POST /items/batch` (the
 * create branch): the chunk-set committed guard → the file-count quota → the insert. Cycle
 * detection stays with the caller (POST does it inline, the batch as a pre-flight) because it
 * differs by the source of the projected map.
 */
export async function createItemTx(
    executor: DbExecutor,
    userId: string,
    data: NewItemData,
    opts?: { knownFileCount?: number; accumulator?: QuotaAccumulator },
): Promise<CreateOutcome> {
    if (!fileSetBindable(data.type, data.chunk_set_id)) {
        return { kind: "error", status: 409, error: "Referenced chunk set is not committed" };
    }
    if (data.type === "file" && data.chunk_set_id) {
        const bound = await bindFileSet(executor, userId, data.chunk_set_id, {
            accumulator: opts?.accumulator,
        });
        if (!bound.ok) return { kind: "error", status: bound.status, error: bound.error };
    }

    if (
        data.type === "file" &&
        (await fileCountExceeded(userId, maxFileCount(), executor, opts?.knownFileCount))
    ) {
        return { kind: "error", status: 429, error: "file_count_limit_exceeded" };
    }
    const row = await insertItemRow(executor, userId, data);
    return { kind: "created", row };
}

/**
 * Item ownership check (used by the history routes).
 *
 * `forUpdate` (SELECT ... FOR UPDATE): lock the row inside the transaction before checking the
 * version. Without it, two parallel requests can both read the same (old) version, both pass the
 * application-level `version !== incoming.version` check, and the second UPDATE blindly overwrites
 * the first (a lost update / split brain — see PUT /items/:id and POST /items/batch). The lock
 * serialises concurrent writers on the same row: the second request blocks until the first commits,
 * so once unblocked it sees the already-updated version and correctly falls into the conflict
 * branch. Use ONLY with `tx` (inside db.transaction) — it is meaningless outside one.
 */
export async function getOwnedItem(
    executor: DbExecutor,
    id: string,
    userId: string,
    forUpdate = false,
): Promise<typeof items.$inferSelect | undefined> {
    const cond = and(eq(items.id, id), eq(items.user_id, userId));
    const [row] = forUpdate
        ? await executor.select().from(items).where(cond).for("update").limit(1)
        : await executor.select().from(items).where(cond).limit(1);
    return row;
}

/**
 * Ownership AND "this is still a real item" — a purged row is a tombstone, not content.
 *
 * `getOwnedItem` deliberately returns tombstones: the purge and restore paths need to see them. The
 * history routes do not, and treating a tombstone as a live item is how a permanently deleted note
 * kept answering `GET /items/:id/history` (see the itemHistory delete in `purgeItemTx`). The purge
 * now removes the snapshots, so this is the second lock rather than the fix — a future purge path
 * that forgets still cannot serve a deleted note's versions.
 */
export async function userOwnsLiveItem(itemId: string, userId: string): Promise<boolean> {
    const item = await getOwnedItem(db, itemId, userId);
    return !!item && item.purged_at == null;
}
