// The push result — a shared handler for the foreground push and the background queue: what happens
// locally once the server has answered an /items/batch push (accepted, a version conflict that
// becomes a conflict copy, or a per-item rejection), plus the handling of a refused purge.
import type { AnyItemPayload, NotePayload } from "@zknotes/shared";
import type { PushBatchResult } from "$lib/core/api";
import { APP_EVENTS } from "$lib/core/constants/events";
import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import { getDB, type LocalItem } from "$lib/core/db";
import { addOrUpdateDoc, removeDoc } from "$lib/core/search";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { extractPlainText } from "$lib/core/utils/tiptap-text";
import { createConflictCopyForItem, isConflictIdentical } from "./conflict";
import { type DB, enqueueMutation } from "./outbox";
import { syncStore } from "./store.svelte";
import { wireToLocalItem } from "./wire";

/**
 * Decrypts an item's payload and pushes it into the search index. If `payload` is already decrypted
 * (passed in from `hydrateConflictMarker`), it is reused — no double decryption.
 * Best effort: errors are logged but do not interrupt the sync.
 */
async function indexItemFromServer(item: LocalItem, payload?: AnyItemPayload): Promise<void> {
    if (item.deleted_at || item.purged_at) {
        // Trashed and deleted items have no payload, or we do not want them in the index
        void removeDoc(item.id).catch(() => {});
        return;
    }

    try {
        if (!item.encrypted_payload || !item.payload_nonce) return;

        const p = payload ?? (await decryptItemPayload<Partial<NotePayload>>(item));
        await addOrUpdateDoc({
            id: item.id,
            type: item.type,
            title: p.title || "Untitled",
            content: item.type === "note" && p.content ? extractPlainText(p.content) : undefined,
        });
    } catch (e) {
        console.warn(`Failed to index synced item ${item.id}`, e);
    }
}

/**
 * Applies the result of an /items/batch push to IndexedDB — one implementation for the foreground
 * push (pushItem) and for the background queue (pushPendingMutations).
 *
 * - succeeded: take the server's version/updated_at/created_at. `sentLocalRev` preserves the
 *   foreground semantics: dirty is cleared only if the item did not change again while the push
 *   waited in the mutex; undefined = clear unconditionally (the background queue).
 * - conflicts: a conflict copy per type (files are not re-keyed), the local version
 *   replaced by the server's, and a reindex.
 * - errors: a log entry, the "Parent is not a folder" self-heal (pre-fix uploads with parent_id =
 *   noteId → null, so the retry ends up in the root /files) and a syncStore error. The retry
 *   decision is the caller's, made from the returned IDs (foreground: enqueue; background: backoff).
 */
type SucceededEntry = PushBatchResult["succeeded"][number];

type ConflictEntry = PushBatchResult["conflicts"][number];

type RejectionEntry = NonNullable<PushBatchResult["errors"]>[number];

/**
 * The server accepted the item: take its version/updated_at/created_at. `sentLocalRev` preserves the
 * foreground semantics — dirty is cleared only if the item did not change again while the push
 * waited in the mutex; undefined = clear unconditionally (the background queue).
 */
async function applySucceeded(db: DB, s: SucceededEntry, sentLocalRev?: number): Promise<void> {
    const tx = db.transaction("items", "readwrite");
    const store = tx.objectStore("items");
    const current = await store.get(s.id);
    if (current) {
        current.version = s.version;
        current.updated_at = s.updated_at;
        current.created_at = s.created_at;
        if (
            sentLocalRev === undefined ||
            current.localRev === sentLocalRev ||
            current.localRev === undefined
        ) {
            current.dirty = false;
        }
        await store.put(current);
    }
    await tx.done;
}

/**
 * The outcome of handling a 409 — the caller (drain / pushItem) must not clear the mutation queue on
 * `requeue` (a crypto failure, or a future defer, must never leave a dirty item unqueued).
 */
type ApplyConflictResult = "resolved" | "requeue";

/**
 * A version mismatch (409): **the server always becomes the local main** (dirty:false); local
 * changes that are not identical to the server's go into a conflict copy (files share the chunk
 * set).
 *
 * A localRev race during crypto: the old "race fix" merely bumped `version` to the server's on
 * a diverged localRev and kept L2 as main — **S was never archived**, so the next push overwrote the
 * remote. Now: a re-read AFTER the crypto; if localRev changed, the conflict is built from
 * **latest** (anti-L1) and the main is **always** the serverItem. No version gets a free pass.
 *
 * WARNING: createConflictCopyForItem is async (crypto) — NOT inside an IDB transaction.
 */
async function applyConflict(db: DB, c: ConflictEntry): Promise<ApplyConflictResult> {
    const snap = await db.get("items", c.id);
    if (!snap) return "resolved";

    try {
        const serverItem = wireToLocalItem(c.current_item);

        let conflictCopy: LocalItem | null = null;
        let conflictTitle: string | null = null;

        // The snapshot (L1) vs the server — a possible first crypto pass; it can be discarded if localRev grows.
        if (!(await isConflictIdentical(snap, serverItem))) {
            const res = await createConflictCopyForItem(snap);
            conflictCopy = res.item;
            conflictTitle = res.title;
        }

        // A re-read AFTER the crypto, BEFORE any path is taken (the race decision).
        const latest = await db.get("items", c.id);
        if (!latest) {
            // The item disappeared during the crypto (a purge) — there is nothing to merge.
            return "resolved";
        }

        if (latest.localRev !== snap.localRev) {
            // The user or another tab touched the item during createConflictCopy — the L1 copy is stale.
            // The conflict comes from L2 (latest); main = S (no free-pass version on L2).
            // The create helper already indexed the L1 copy — drop that doc, or search keeps a hit
            // that opens a note which was never stored.
            if (conflictCopy) void removeDoc(conflictCopy.id).catch(() => {});
            if (!(await isConflictIdentical(latest, serverItem))) {
                const res = await createConflictCopyForItem(latest);
                conflictCopy = res.item;
                conflictTitle = res.title;
            } else {
                conflictCopy = null;
                conflictTitle = null;
            }
        }

        const tx = db.transaction("items", "readwrite");
        const store = tx.objectStore("items");
        const stillThere = await store.get(c.id);
        if (!stillThere) {
            await tx.done;
            return "resolved";
        }
        // A write landed after `latest` was read (autosave / other tab). Requeue rather than
        // clobbering that revision with the server row — the conflict copy would otherwise be
        // built from a stale snapshot and the newer local edit would vanish.
        if ((stillThere.localRev ?? 0) !== (latest.localRev ?? 0)) {
            await tx.done;
            return "requeue";
        }

        if (conflictCopy) {
            await store.put(conflictCopy);
        }
        // The server is always the canonical original (wireToLocalItem: dirty:false, the enc fields coerced).
        // localRev is carried forward and bumped, never reset to undefined: a save whose decrypt is
        // in flight compares against it (item-service CAS, where `?? 0` cannot tell a reset apart
        // from a never-edited row), and history's snapshot marker counts on it (a reset silently
        // skipped snapshots for as many edits as the old count).
        await store.put({ ...serverItem, localRev: (stillThere.localRev ?? 0) + 1 });
        await tx.done;

        // Straight after the commit, before any await: a save of the open editor that reads the row
        // from here on must already find the copy to write into (one conflict = one copy).
        if (
            conflictCopy &&
            conflictTitle &&
            conflictCopy.type === "note" &&
            typeof window !== "undefined"
        ) {
            window.dispatchEvent(
                new CustomEvent(APP_EVENTS.notePushConflict, {
                    detail: { noteId: c.id, copyId: conflictCopy.id, copyTitle: conflictTitle },
                }),
            );
        }

        void indexItemFromServer(serverItem);

        if (conflictCopy && conflictTitle) {
            conflictStore.add({
                id: conflictCopy.id,
                title: conflictTitle,
                type: conflictCopy.type,
                at: Math.floor(Date.now() / 1000),
            });
            await enqueueMutation(conflictCopy.id, "upsert");
        }
        return "resolved";
    } catch (conflictErr) {
        // An error (from the crypto worker, say) → keep it locally, surface a UI error, requeue.
        console.error("Failed to create conflict copy for", c.id, conflictErr);
        syncStore.markSyncError("Sync conflict couldn't be resolved — retrying");
        return "requeue";
    }
}

/**
 * How many times "Parent not found" may pass as a transient error before the item drops to the root
 * after all. A parent that has not reached the server in that many drain cycles (backoff 1 s → 5 min)
 * is no longer "still in flight" but a real desync, and an infinite retry would leave the item
 * unsynced forever.
 */
const PARENT_RETRY_BUDGET = 3;

/**
 * Whether a rejection may be self-healed by an IRREVERSIBLE move to the root.
 *
 * "Parent is not a folder" and "File parent must be a note" are TYPE errors — the parent exists but
 * is of the wrong kind; a retry would never fix them, so the root is the only way out (pre-fix
 * uploads among them).
 *
 * "Parent not found" is ambiguous, and therefore dangerous: the parent either really is gone, or has
 * NOT reached the server yet (an earlier chunk failed on the network, the parent was rejected on
 * quota, another device is lagging). It used to be nulled immediately — which is how a bulk
 * restore silently moved notes out of their folders into the root, where their retained `sort_order`
 * also broke the tree's ordering. Now we reparent only once the parent is missing locally too (it
 * really is gone) or once it has failed to appear after `PARENT_RETRY_BUDGET` attempts.
 */
async function shouldReparentToRoot(db: DB, e: RejectionEntry, stale: LocalItem): Promise<boolean> {
    if (e.error !== "Parent not found") return true;

    const parent = stale.parent_id ? await db.get("items", stale.parent_id) : undefined;
    if (!parent || parent.purged_at != null) return true;

    const mut = await db.get("mutation-queue", e.id);
    return (mut?.attempt_count ?? 0) >= PARENT_RETRY_BUDGET;
}

/**
 * The server has permanently purged that row (`purged_at`), so an upsert can NEVER succeed — "Item is
 * permanently deleted" is a permanent state, not a transient error. Without special handling the
 * mutation stays in the queue forever and every drain sends it again (an infinite loop plus a
 * permanent sync error).
 *
 * The local content must NOT be deleted in the process. The typical source of such an item is a
 * **backup restore** carrying a note the server purged meanwhile (the 30-day Trash retention
 * expired) — deleting it would silently undo the user's restore. So the item is marked
 * `pending_purge_conflict`, exactly like the pull branch for a tombstone:
 * `retryPendingPurgeConflicts` moves it on the next drain into a NEW item (a new UUIDv7 and a new
 * Item Key) that the server accepts, writes it into the Conflict Inbox, and only then removes the
 * original.
 *
 * If `purged_at` is set locally too, the user permanently deleted it themselves — there is nothing
 * to resurrect and the mutation simply drops out of the queue (the delete branch handles the
 * tombstone).
 *
 * Returns `true` when the case has been handled and the mutation may drop out of the queue.
 */
async function applyPurgedOnServer(db: DB, id: string): Promise<boolean> {
    const local = await db.get("items", id);
    if (!local) return true;

    if (local.purged_at != null) {
        // Client and server both consider it permanently deleted — an upsert has nothing to send.
        // Clear `dirty` so the re-enqueue branch does not put it back as an upsert; the tombstone
        // travels through the delete branch.
        if (local.dirty) {
            local.dirty = false;
            await db.put("items", local);
        }
        return true;
    }

    if (local.sync_error !== "pending_purge_conflict") {
        local.sync_error = "pending_purge_conflict";
        await db.put("items", local);
    }
    return true;
}

/**
 * Per-item rejections that no retry can ever turn into a success. A retry loop for these would run
 * every backoff cycle forever, keep the item dirty in the queue, keep the red sync banner up and
 * keep the login gate warning about "unsynced work" — with no way for the user to make it stop.
 *
 * - "Referenced chunk set is not committed": at push time an upload's set is always already
 *   finalized, so this means the server no longer has the set (the orphan sweep took it).
 *   Parking it with `sync_error` also lets the files module see it and re-upload from staging.
 * - "item_id_taken": the id belongs to another user's row — a UUIDv7 collision that never resolves.
 * - "item_type_mismatch": the update declares a different type than the stored row. A type is fixed
 *   at creation, so no retry can ever be accepted.
 *
 * Quota-type rejections (`hard_limit_exceeded`, the count ceilings) are deliberately NOT here: they
 * resolve once the user frees space or upgrades, so they keep retrying.
 */
export const CHUNK_SET_NOT_COMMITTED_ERROR = "Referenced chunk set is not committed";

const TERMINAL_ITEM_ERRORS: ReadonlySet<string> = new Set([
    CHUNK_SET_NOT_COMMITTED_ERROR,
    "item_id_taken",
    "item_type_mismatch",
]);

type RejectionOutcome = { id: string; terminal: boolean } | null;

/**
 * The server rejected the item (a file whose chunk set is not committed yet, items.ts
 * fileSetInvalid). Do not discard it: surface the reason (plus the "Parent is not a folder"
 * self-heal for pre-fix uploads with parent_id=noteId → null) and leave the re-enqueue or backoff to
 * the caller, through the returned ID. Ignoring it silently left uploaded files stuck locally
 * forever. `terminal` marks the errors the drain parks after a few attempts (see TERMINAL_ITEM_ERRORS).
 */
async function applyRejection(db: DB, e: RejectionEntry): Promise<RejectionOutcome> {
    console.error(`Server rejected item ${e.id} during push: ${e.error}`);

    // A permanently purged row: resurrect the content under a new ID instead of retrying forever (see the helper).
    if (e.error === "Item is permanently deleted") {
        if (await applyPurgedOnServer(db, e.id)) return null;
    }

    // Self-heal: a wrong or missing parent — null out parent_id so it does not loop forever.
    if (
        e.error === "Parent is not a folder" ||
        e.error === "File parent must be a note" ||
        e.error === "Parent not found"
    ) {
        const stale = await db.get("items", e.id);
        if (stale && stale.parent_id !== null && (await shouldReparentToRoot(db, e, stale))) {
            stale.parent_id = null;
            stale.dirty = true;
            stale.localRev = (stale.localRev || 0) + 1;
            await db.put("items", stale);
        }
    }

    if (e.error === "hard_limit_exceeded") {
        syncStore.markSyncError(
            "Storage limit reached. Free up space (emptying the trash counts) to sync this item.",
        );
    } else {
        syncStore.markSyncError(`File didn't sync: ${e.error ?? "rejected by server"}`);
    }
    return { id: e.id, terminal: e.error !== undefined && TERMINAL_ITEM_ERRORS.has(e.error) };
}

export async function applyPushResult(
    result: PushBatchResult,
    opts: { sentLocalRev?: number; sentLocalRevs?: Map<string, number> } = {},
): Promise<{ rejectedIds: string[]; requeueIds: string[]; terminalErrors: Map<string, string> }> {
    const db = await getDB();

    for (const s of result.succeeded) {
        const rev = opts.sentLocalRevs?.get(s.id) ?? opts.sentLocalRev;
        await applySucceeded(db, s, rev);
    }

    const requeueIds: string[] = [];
    for (const c of result.conflicts) {
        if ((await applyConflict(db, c)) === "requeue") requeueIds.push(c.id);
    }

    const rejectedIds: string[] = [];
    const terminalErrors = new Map<string, string>();
    for (const e of result.errors ?? []) {
        // null = fully handled (a purged row, for instance) → the mutation may drop out of the queue.
        const outcome = await applyRejection(db, e);
        if (outcome === null) continue;
        rejectedIds.push(outcome.id);
        if (outcome.terminal && e.error) terminalErrors.set(outcome.id, e.error);
    }

    return { rejectedIds, requeueIds, terminalErrors };
}

/**
 * A permanent delete was refused (a version mismatch) — accept the server's state without making a
 * conflict copy of the local purge tombstone (that is not user content worth preserving).
 *
 * The queued `delete` mutation for that id MUST go too. The row we just stored is the server's live
 * item, and `drainDeleteMutations` reads the version to send from the local row — a leftover queue
 * entry would therefore be sent with the server's CURRENT version on the next drain, match, and purge
 * the very item the version guard just protected (a restore on another device silently undone).
 */
export async function applyDeleteRejected(db: DB, c: ConflictEntry): Promise<void> {
    const serverItem = wireToLocalItem(c.current_item);
    await db.put("items", serverItem);
    await db.delete("mutation-queue", c.id);
    void indexItemFromServer(serverItem);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
    }
}

/**
 * The public form of the refused-purge handling, for callers that push `delete_ids` themselves
 * (FileService.hardDelete): restore the server's live row locally and drop any queued delete for
 * it, so neither the local tombstone nor a stale mutation can destroy the newer server state.
 */
export async function applyRefusedDeletes(conflicts: PushBatchResult["conflicts"]): Promise<void> {
    if (conflicts.length === 0) return;
    const db = await getDB();
    for (const c of conflicts) {
        await applyDeleteRejected(db, c);
    }
}
