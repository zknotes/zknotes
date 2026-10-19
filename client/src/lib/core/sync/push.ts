// The push — sends local changes to the server: the foreground push of one item or of a purge,
// serialised per tab and across tabs, and the background drain of the outbox with its backoff, its
// batch splitting and its recovery paths.
import { type DeleteId, FILE_LIMITS, SYNC_LIMITS, topoSortByParent } from "@zknotes/shared";
import { ApiError, pushBatch } from "$lib/core/api";
import { emitVaultItemsChanged } from "$lib/core/constants/events";
import type { EncryptedItem, LocalItem, MutationQueueItem } from "$lib/core/db";
import { getDB } from "$lib/core/db";
import { fileBridge } from "$lib/core/events/file-bridge";
import { evictChunkSet } from "$lib/core/files/chunk-loader";
import { removeDoc } from "$lib/core/search";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { loadPersisted, rawStringSerde, STORAGE_KEYS } from "$lib/core/utils/persisted";
import { announceConflictCopy, createConflictCopyForItem } from "./conflict";
import { type DB, enqueueMutation, notifyQueueChanged, shouldRetry } from "./outbox";
import { applyDeleteRejected, applyPushResult } from "./push-result";
import { syncStore } from "./store.svelte";
import { withSyncLock } from "./sync-lock";
import { hasLocalChunkSetRef, toWireFormat } from "./wire";

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
}

/**
 * Recognises a server refusal (a 4xx other than 408 and 429) that means a permanent problem with
 * the item or the request. Only the API's own typed error counts — a network failure, a timeout or
 * an unrelated object that happens to carry a `status` is not a verdict on the item.
 */
export function isPermanentPushError(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false;
    const { status } = err;
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Splits mutations both by a maximum operation count (MAX_BATCH_OPS) AND by bytes
 * (MAX_BATCH_BYTES).
 *
 * Before chunking it sorts topologically by `parent_id`. The `mutation-queue` is keyed by ID,
 * so `getAll` returns it in UUIDv7 order = CREATION order. A note moved into a folder created later
 * therefore sits BEFORE its parent, and during a bulk push (a backup restore) it can land in an
 * earlier chunk — the server rejects it with "Parent not found", because the parent is in neither
 * the batch nor the database yet. The topological sort guarantees the parent is in the same or an
 * earlier chunk, and earlier chunks have already been committed.
 */
async function chunkUpsertMutationsByBytesAndCount<T extends { id: string }>(
    db: DB,
    muts: T[],
    maxOps: number = FILE_LIMITS.MAX_BATCH_OPS,
    maxBytes: number = SYNC_LIMITS.MAX_BATCH_BYTES,
): Promise<T[][]> {
    // One pass through IDB: the bytes and the parent_id alike (a mutation carries no hierarchy of its own).
    const itemBytesById = new Map<string, number>();
    const parentById = new Map<string, string | null>();
    for (const mut of muts) {
        const item = await db.get("items", mut.id);
        itemBytesById.set(mut.id, item?.encrypted_payload?.length ?? 500);
        parentById.set(mut.id, item?.parent_id ?? null);
    }

    const chunks: T[][] = [];
    let currentChunk: T[] = [];
    let currentBytes = 0;

    for (const mut of topoSortByParent(muts, (m) => parentById.get(m.id) ?? null)) {
        const itemBytes = itemBytesById.get(mut.id) ?? 500;
        if (
            currentChunk.length > 0 &&
            (currentChunk.length >= maxOps || currentBytes + itemBytes > maxBytes)
        ) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentBytes = 0;
        }
        currentChunk.push(mut);
        currentBytes += itemBytes;
    }
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }
    return chunks;
}

/** True when the user changed and the previous user's data has not been cleared yet. */
function isUserSwitchPending(): boolean {
    return loadPersisted(STORAGE_KEYS.pendingClearForUser, "", rawStringSerde) === "true";
}

/** How many drain attempts a terminal per-item rejection gets before it is parked with `sync_error`. */
const TERMINAL_REJECTION_ATTEMPTS = 3;

/**
 * Parks an item whose rejection is terminal (TERMINAL_ITEM_ERRORS): out of the queue, `sync_error`
 * set, the content kept and still dirty (a pull must not overwrite it; clearSyncErrorsAndRequeue or
 * the files module's re-upload puts it back). The same shape as the thrown-4xx park below.
 */
/**
 * One more failed attempt for a queued mutation. With `park` given and the mutation now failed
 * TERMINAL_REJECTION_ATTEMPTS times it is parked by that function; otherwise it goes back into the
 * queue with a fresh `attempted_at` for the backoff. Five sites used to spell this out by hand, three
 * of them with the threshold as a literal.
 */
async function retryOrPark(
    db: DB,
    mut: MutationQueueItem,
    park: (() => Promise<void>) | null,
): Promise<void> {
    mut.attempt_count = (mut.attempt_count || 0) + 1;
    if (park && mut.attempt_count >= TERMINAL_REJECTION_ATTEMPTS) {
        await park();
        return;
    }
    mut.attempted_at = Date.now();
    await db.put("mutation-queue", mut);
}

/**
 * Parks an item the server rejects permanently (isPermanentPushError): out of the queue, `sync_error`
 * set, the content kept and still dirty — a pull must not silently overwrite the local copy, and
 * clearSyncErrorsAndRequeue puts it back.
 */
async function parkPermanentFailure(db: DB, id: string, message: string): Promise<void> {
    await db.delete("mutation-queue", id);
    const item = await db.get("items", id);
    if (!item) return;
    item.sync_error = message;
    await db.put("items", item);
    syncStore.noteParkedFailure();
}

async function parkTerminalRejection(db: DB, id: string, error: string): Promise<void> {
    await db.delete("mutation-queue", id);
    const item = await db.get("items", id);
    if (!item) return;
    item.sync_error = error;
    await db.put("items", item);
    syncStore.noteParkedFailure();
}

// ---------------------------------------------------------------------------
//  Push — foreground, with a mutex for serialisation
// ---------------------------------------------------------------------------

let pushLock = Promise.resolve();

/**
 * Pushes one item to the server. Serialised by:
 * - a per-tab `pushLock` (the same tab, fire-and-forget chains)
 * - a cross-tab Web Lock (`withSyncLock`), so a foreground push does not race another tab's drain
 */
/** Push now; when that fails (offline, a server error) leave the change to the outbox drain. */
export function pushOrQueue(item: LocalItem): void {
    pushItem(item).catch(() => enqueueMutation(item.id, "upsert"));
}

export function pushItem(item: LocalItem): Promise<void> {
    // During a bulk import, or while a user switch is pending, only enqueue — do not hit the network.
    if (syncStore.isSuspended || isUserSwitchPending()) {
        return enqueueMutation(item.id, "upsert");
    }
    const id = item.id;
    pushLock = pushLock
        .then(async () => {
            await withSyncLock(() => _pushItemImpl(id));
        })
        .catch(() => {});
    return pushLock;
}

/** Waits for every in-flight foreground and background push to finish (before a bulk import). */
export function waitForPushIdle(): Promise<void> {
    return pushLock;
}

/**
 * Pushes a batch delete request to the server. Serialised (per-tab plus a Web Lock) so a delete does
 * not overtake an upsert, not even in another tab.
 */
export function pushDeletes(ids: string[]): Promise<void> {
    if (syncStore.isSuspended || isUserSwitchPending()) {
        return Promise.all(ids.map((id) => enqueueMutation(id, "delete"))).then(() => {});
    }
    const snapshot = [...ids];
    pushLock = pushLock
        .then(async () => {
            await withSyncLock(() => _pushDeletesImpl(snapshot));
        })
        .catch(() => {});
    return pushLock;
}

/**
 * Enriches the delete ids with the current local version (a version-aware delete): the server
 * purges only if the version matches, so a stale delete from another device does not destroy a newer
 * state. If the local row no longer exists, a bare id is sent (an unconditional purge — we have no
 * version to compare against).
 */
async function toDeleteEntries(db: DB, ids: string[]): Promise<DeleteId[]> {
    const entries: DeleteId[] = [];
    for (const id of ids) {
        const item = await db.get("items", id);
        entries.push(item ? { id, version: item.version } : id);
    }
    return entries;
}

async function _pushDeletesImpl(ids: string[]): Promise<void> {
    const db = await getDB();
    const entries = await toDeleteEntries(db, ids);
    syncStore.beginPush();
    try {
        const purgedFileIds: string[] = [];
        for (const chunk of chunkArray(entries, FILE_LIMITS.MAX_BATCH_OPS)) {
            const result = await pushBatch([], chunk);
            // The version-aware purge was refused — do not delete locally; restore the server's state
            // (applyDeleteRejected also drops the queued delete, see its doc).
            const conflictIds = new Set(result.conflicts.map((c) => c.id));
            for (const c of result.conflicts) {
                await applyDeleteRejected(db, c);
            }
            for (const entry of chunk) {
                const id = typeof entry === "string" ? entry : entry.id;
                if (!conflictIds.has(id)) {
                    const row = await db.get("items", id);
                    if (row?.type === "file") purgedFileIds.push(id);
                    await db.delete("items", id);
                    await db.delete("mutation-queue", id);
                }
            }
        }
        syncStore.markSyncSuccess();
        // The embed strip happens only once the server has acknowledged the purge — a refused purge
        // must not leave a live file without its embed (the same rule as the pull's tombstone branch).
        if (purgedFileIds.length > 0) {
            void fileBridge.cleanupOrphanedFileRefs(purgedFileIds).catch(() => {});
        }
    } catch {
        for (const id of ids) {
            await enqueueMutation(id, "delete");
        }
    } finally {
        syncStore.endPush();
    }
}

async function _pushItemImpl(itemId: string): Promise<void> {
    const db = await getDB();

    // Re-read from IndexedDB — the item may have been updated while we waited in the mutex queue
    const freshItem = await db.get("items", itemId);
    if (!freshItem?.dirty) return; // nothing to push

    const sentLocalRev = freshItem.localRev;
    const wireItem = toWireFormat(freshItem);

    syncStore.beginPush();
    try {
        const result = await pushBatch([wireItem]);

        syncStore.markSyncSuccess();

        const { rejectedIds, requeueIds } = await applyPushResult(result, { sentLocalRev });
        for (const id of rejectedIds) {
            await enqueueMutation(id, "upsert");
        }
        // An unresolved conflict path (a crypto failure) has to stay in the queue — do not clear
        // it.
        for (const id of requeueIds) {
            await enqueueMutation(id, "upsert");
        }
        if (!rejectedIds.includes(itemId) && !requeueIds.includes(itemId)) {
            // The foreground push succeeded (or a 409 was resolved) — drop the stale queue row so a
            // background retry does not race a newer local state (delete→restore→delete).
            await db.delete("mutation-queue", itemId);
            // A concurrent edit during the push → it stayed dirty → re-enqueue at once.
            const after = await db.get("items", itemId);
            if (after?.dirty && !after.sync_error) {
                await enqueueMutation(itemId, "upsert");
            }
            void syncStore.refreshPendingCount();
            // Refresh the tree: dirty just turned false in IDB, so the spinner should disappear.
            emitVaultItemsChanged();
        } else {
            void syncStore.refreshPendingCount();
        }
    } catch {
        // A network error — put it in the queue for a retry
        await enqueueMutation(itemId, "upsert");
    } finally {
        syncStore.endPush();
    }
}

// ---------------------------------------------------------------------------
//  Pushing pending mutations — background, with an exponential backoff
// ---------------------------------------------------------------------------

/**
 * Drains the mutation queue. By default it respects the exponential backoff (the background
 * scheduler). `{ force: true }` is the user's "Sync now": send everything at once, ignoring the retry
 * window.
 */
export function pushPendingMutations(opts?: { force?: boolean }): Promise<void> {
    if (syncStore.isSuspended || isUserSwitchPending()) return Promise.resolve();
    const force = opts?.force === true;
    // Serialised with the foreground pushItem (per tab) + a Web Lock (cross-tab). When the scheduler
    // already holds the lock, withSyncLock is reentrant (it does not deadlock).
    pushLock = pushLock
        .then(async () => {
            await withSyncLock(() => _pushPendingMutationsImpl(force));
        })
        .catch(() => {});
    return pushLock;
}

/**
 * The drain's upsert branch: it sends mutations in batches (up to FILE_LIMITS.MAX_BATCH_OPS per
 * request) instead of one at a time. Previously every mutation went in its own /items/batch call —
 * coming back online with many offline changes meant N sequential HTTP requests (slow, and liable to
 * hit the rate limit), which defeats the point of a batch endpoint. The server topologically sorts
 * parents ahead of children within one batch itself.
 */
async function drainUpsertMutations(
    db: DB,
    muts: Array<{
        id: string;
        type: "upsert" | "delete";
        attempted_at: number;
        attempt_count: number;
    }>,
): Promise<void> {
    const chunks = await chunkUpsertMutationsByBytesAndCount(db, muts);
    for (const chunk of chunks) {
        const wireItems: EncryptedItem[] = [];
        const sentLocalRevs = new Map<string, number>();
        const validMuts: typeof chunk = [];

        for (const mut of chunk) {
            const item = await db.get("items", mut.id);
            if (!item) {
                // The item was deleted locally — take it out of the queue
                await db.delete("mutation-queue", mut.id);
                continue;
            }
            // Record localRev BEFORE sending: if the user edits the item while the push waits for
            // the server's answer, localRev grows, so applySucceeded keeps dirty=true and the new
            // changes are not lost.
            sentLocalRevs.set(item.id, item.localRev ?? 0);
            wireItems.push(toWireFormat(item));
            validMuts.push(mut);
        }
        if (wireItems.length === 0) continue;

        try {
            const result = await pushBatch(wireItems);
            syncStore.markSyncSuccess();

            const { rejectedIds, requeueIds, terminalErrors } = await applyPushResult(result, {
                sentLocalRevs,
            });
            const keepInQueue = new Set([...rejectedIds, ...requeueIds]);
            for (const mut of validMuts) {
                if (keepInQueue.has(mut.id)) {
                    // Rejected (by the server) or requeued (a conflict crypto failure) — back off,
                    // do not clear.
                    const terminal = terminalErrors.get(mut.id);
                    await retryOrPark(
                        db,
                        mut,
                        terminal ? () => parkTerminalRejection(db, mut.id, terminal) : null,
                    );
                } else {
                    await db.delete("mutation-queue", mut.id);
                    // applySucceeded kept dirty (a concurrent localRev) — without a re-enqueue
                    // the item stays dirty outside the queue and the pull skips it forever.
                    const after = await db.get("items", mut.id);
                    if (after?.dirty && !after.sync_error) {
                        await enqueueMutation(mut.id, "upsert");
                    }
                }
            }
        } catch (err) {
            const isPermanent = isPermanentPushError(err);
            const msg = isPermanent
                ? err instanceof Error
                    ? err.message
                    : "Permanent push error"
                : "";
            if (isPermanent) {
                syncStore.markSyncError(msg);
            }
            // A whole-batch 400 "Cycle detected" cannot be attributed per item. Re-parent the
            // dirty folders to the root and retry — leaving them parked hides the whole subtree.
            if (
                isPermanent &&
                typeof msg === "string" &&
                msg.toLowerCase().includes("cycle detected")
            ) {
                for (const mut of validMuts) {
                    const item = await db.get("items", mut.id);
                    if (!item || item.type !== "folder" || item.parent_id == null) continue;
                    item.parent_id = null;
                    item.dirty = true;
                    item.sync_error = undefined;
                    item.localRev = (item.localRev || 0) + 1;
                    await db.put("items", item);
                    mut.attempt_count = 0;
                    mut.attempted_at = 0;
                    await db.put("mutation-queue", mut);
                }
                continue;
            }
            // An HTTP 4xx on the WHOLE batch must not poison up to MAX_BATCH_OPS items.
            // A multi-item permanent failure → isolate it: push one at a time, so only the genuinely
            // bad ids get a sync_error after 3 solo attempts.
            if (isPermanent && validMuts.length > 1) {
                for (const mut of validMuts) {
                    const item = await db.get("items", mut.id);
                    if (!item) {
                        await db.delete("mutation-queue", mut.id);
                        continue;
                    }
                    try {
                        const solo = await pushBatch([toWireFormat(item)]);
                        syncStore.markSyncSuccess();
                        const { rejectedIds, requeueIds, terminalErrors } = await applyPushResult(
                            solo,
                            { sentLocalRevs: new Map([[item.id, item.localRev ?? 0]]) },
                        );
                        if (rejectedIds.includes(mut.id) || requeueIds.includes(mut.id)) {
                            const terminal = terminalErrors.get(mut.id);
                            await retryOrPark(
                                db,
                                mut,
                                terminal ? () => parkTerminalRejection(db, mut.id, terminal) : null,
                            );
                        } else {
                            await db.delete("mutation-queue", mut.id);
                            const after = await db.get("items", mut.id);
                            if (after?.dirty && !after.sync_error)
                                await enqueueMutation(mut.id, "upsert");
                        }
                    } catch (soloErr) {
                        const message =
                            soloErr instanceof Error ? soloErr.message : "Permanent push error";
                        await retryOrPark(
                            db,
                            mut,
                            isPermanentPushError(soloErr)
                                ? () => parkPermanentFailure(db, mut.id, message)
                                : null,
                        );
                    }
                }
                continue;
            }
            for (const mut of validMuts) {
                await retryOrPark(
                    db,
                    mut,
                    isPermanent ? () => parkPermanentFailure(db, mut.id, msg) : null,
                );
            }
        }
    }
}

/**
 * The recovery: clear `sync_error` from dirty items and put them back into the mutation queue.
 * Called by the Sync panel and by "Retry failed items" in settings.
 */
export async function clearSyncErrorsAndRequeue(): Promise<number> {
    const db = await getDB();
    const all = await db.getAll("items");
    let n = 0;
    for (const item of all) {
        if (!item.sync_error) continue;
        // pending_purge_conflict is handled by retryPendingPurgeConflicts, not by an ordinary upsert.
        if (item.sync_error === "pending_purge_conflict") continue;
        delete item.sync_error;
        await db.put("items", item);
        if (item.dirty) {
            await enqueueMutation(item.id, "upsert");
            n++;
        }
    }
    void syncStore.refreshPendingCount();
    return n;
}

/** The drain's delete branch: a version-aware purge, batched (the same chunking as _pushDeletesImpl). */
async function drainDeleteMutations(
    db: DB,
    muts: Array<{
        id: string;
        type: "upsert" | "delete";
        attempted_at: number;
        attempt_count: number;
    }>,
): Promise<void> {
    for (const rawChunk of chunkArray(muts, FILE_LIMITS.MAX_BATCH_OPS)) {
        const entries: DeleteId[] = [];
        const chunk: typeof rawChunk = [];
        const purgedFileIds: string[] = [];
        for (const mut of rawChunk) {
            // A version-aware delete: send the tombstone's current local version if there is one.
            const tombstone = await db.get("items", mut.id);
            // A `delete` mutation whose local row is LIVE (no purged_at) is stale by definition: every
            // purge path tombstones the row before it enqueues, and a refused purge restores the
            // server's live row. Sending it would purge with the now-matching version — drop it.
            if (tombstone && tombstone.purged_at == null) {
                await db.delete("mutation-queue", mut.id);
                continue;
            }
            if (tombstone?.type === "file") purgedFileIds.push(mut.id);
            chunk.push(mut);
            entries.push(tombstone ? { id: mut.id, version: tombstone.version } : mut.id);
        }
        if (entries.length === 0) continue;

        try {
            const result = await pushBatch([], entries);
            syncStore.markSyncSuccess();
            const conflictIds = new Set(result.conflicts.map((c) => c.id));
            for (const c of result.conflicts) {
                // The purge was refused (a stale version) — bring the server state back, do not delete locally.
                await applyDeleteRejected(db, c);
            }
            for (const mut of chunk) {
                if (conflictIds.has(mut.id)) {
                    await db.delete("mutation-queue", mut.id);
                } else {
                    // The server confirmed it — hard-delete locally and take it out of the queue
                    await db.delete("items", mut.id);
                    await db.delete("mutation-queue", mut.id);
                    void removeDoc(mut.id).catch(() => {});
                }
            }
            // The embeds of purged files leave every note only AFTER the server acknowledged the purge
            // (parity with the pull's tombstone branch and the foreground pushDeletes).
            const ackedFiles = purgedFileIds.filter((id) => !conflictIds.has(id));
            if (ackedFiles.length > 0) {
                void fileBridge.cleanupOrphanedFileRefs(ackedFiles).catch(() => {});
            }
        } catch (err) {
            const isPermanent = isPermanentPushError(err);
            if (isPermanent) {
                const msg = err instanceof Error ? err.message : "Permanent delete error";
                syncStore.markSyncError(msg);
            }
            for (const mut of chunk) {
                // A delete the server refuses for good has nothing to park — the row just leaves the queue.
                await retryOrPark(
                    db,
                    mut,
                    isPermanent ? () => db.delete("mutation-queue", mut.id) : null,
                );
            }
        }
    }
}

/**
 * Retrying the fail-closed purge path — the original id is purged on the server, so it must not
 * be pushed; instead retry the conflict copy → a new id plus an enqueue, then remove the original.
 */
/**
 * `preFetchedItems`, when given, is used instead of a fresh `getAll("items")` — the
 * caller (reconcilePendingMutations) already has one and a second full-table scan on every sync
 * cycle is wasted work. The items this function itself deletes or creates are exactly the ones a
 * fresh fetch would differ on, and both outcomes are a no-op for the caller's own loop either way
 * (see reconcilePendingMutations), so sharing a slightly stale snapshot is safe.
 */
export async function retryPendingPurgeConflicts(preFetchedItems?: LocalItem[]): Promise<number> {
    const db = await getDB();
    const allItems = preFetchedItems ?? (await db.getAll("items"));
    let resolved = 0;

    for (const item of allItems) {
        if (item.sync_error !== "pending_purge_conflict") continue;
        try {
            const { item: conflictCopy, title } = await createConflictCopyForItem(item);
            await announceConflictCopy(db, conflictCopy, title, item.type);
            if (item.type === "file" && item.chunk_set_id) {
                const stillShared = hasLocalChunkSetRef(allItems, item.chunk_set_id, item.id);
                // The copy now references the set — the original is deleted, and the set stays for the copy.
                if (!stillShared && conflictCopy.chunk_set_id !== item.chunk_set_id) {
                    void evictChunkSet(item.chunk_set_id).catch(() => {});
                }
            }
            await db.delete("items", item.id);
            void removeDoc(item.id).catch(() => {});
            resolved++;
        } catch (e) {
            console.error("retryPendingPurgeConflicts failed for", item.id, e);
        }
    }
    return resolved;
}

/**
 * Walks every item in IndexedDB and returns to the mutation queue any dirty item or tombstone that
 * is missing its queue entry (a tab closed mid-push, for instance).
 *
 * One `getAll("items")` shared with retryPendingPurgeConflicts instead of two, and
 * one `getAllKeys("mutation-queue")` up front instead of an N+1 `db.get` per item.
 */
export async function reconcilePendingMutations(): Promise<number> {
    const db = await getDB();
    const allItems = await db.getAll("items");
    await retryPendingPurgeConflicts(allItems);
    const queuedIds = new Set(await db.getAllKeys("mutation-queue"));
    let count = 0;

    for (const item of allItems) {
        const hasMut = queuedIds.has(item.id);
        if (item.purged_at != null) {
            if (!hasMut) {
                await enqueueMutation(item.id, "delete");
                count++;
            }
        } else if (item.dirty === true && !item.sync_error) {
            if (!hasMut) {
                await enqueueMutation(item.id, "upsert");
                count++;
            }
        }
    }
    return count;
}

async function _pushPendingMutationsImpl(force = false): Promise<void> {
    const db = await getDB();
    await reconcilePendingMutations();
    const allMutations = await db.getAll("mutation-queue");
    if (allMutations.length === 0) return;

    const dueMutations = force ? allMutations : allMutations.filter(shouldRetry);
    const upsertMuts = dueMutations.filter((m) => m.type === "upsert");
    const deleteMuts = dueMutations.filter((m) => m.type === "delete");
    if (dueMutations.length === 0) {
        // Everything is still inside its backoff window — no push, so no "Syncing…" flash.
        void syncStore.refreshPendingCount();
        return;
    }

    syncStore.beginPush();
    try {
        await drainUpsertMutations(db, upsertMuts);
        await drainDeleteMutations(db, deleteMuts);
    } finally {
        syncStore.endPush();
        // The drain cycle is finished — refresh the pending counter once, not per item.
        void syncStore.refreshPendingCount();
        // Attempt counts changed → the scheduler re-arms its retry timer.
        notifyQueueChanged();
    }
}
