// The conflict-copy helpers — used by the push (409) and the pull (a concurrent change).
// Lifted out of sync/index.ts; the crypto goes through crypto/item-codec.
import { nowSec } from "$lib/core/utils/duration";
import { uuidv7 } from "uuidv7";
import { APP_EVENTS, emitVaultItemsChanged } from "$lib/core/constants/events";
import { decryptItemPayload, encryptItemPayloadToBase64 } from "$lib/core/crypto/item-codec";
import { getDB, type LocalItem } from "$lib/core/db";
import { addOrUpdateDoc, removeDoc } from "$lib/core/search";
import { toSearchDoc } from "$lib/core/search/doc";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { fromBase64, toBase64 } from "$lib/core/utils/base64";
import {
    addCachedItemKey,
    cloneItemKeyTask,
    generateItemKeyTask,
} from "$lib/core/workers/crypto-rpc";
import { reattachEmbedsFromOriginal, stripAllFileRefsFromHtml } from "$lib/core/utils/file-refs";
import { type DB, enqueueMutation, touchForPush } from "./outbox";

/**
 * A conflict copy must not inherit the parent_id of a purged or vanished parent — the push would
 * fail on "Parent not found" with no self-heal. It falls back to the root (null).
 */
export async function resolveConflictParentId(
    preferredParentId: string | null,
): Promise<string | null> {
    if (!preferredParentId) return null;
    const db = await getDB();
    const parent = await db.get("items", preferredParentId);
    if (!parent || parent.purged_at != null) return null;
    return preferredParentId;
}

/**
 * Puts a freshly made conflict copy into play: the row, its mutation, and the inbox entry. The pull
 * (two purge branches), the retry of a failed purge copy and the concurrent-edit fallback all did
 * these three steps by hand.
 */
export async function announceConflictCopy(
    db: DB,
    copy: LocalItem,
    title: string,
    type: LocalItem["type"],
): Promise<void> {
    await db.put("items", copy);
    await enqueueMutation(copy.id, "upsert");
    conflictStore.add({ id: copy.id, title, type, at: nowSec() });
}

/**
 * A dirty local row whose id the server has purged: keep the unpushed text as a conflict copy BEFORE
 * the original goes. Fail closed — when the copy cannot be made the original stays, marked
 * `pending_purge_conflict` for the next sync to retry, and the caller must not delete it.
 * Returns whether the original may now be removed.
 */
export async function preserveDirtyRowAsConflictCopy(db: DB, local: LocalItem): Promise<boolean> {
    try {
        const { item: copy, title } = await createConflictCopyForItem(local);
        await announceConflictCopy(db, copy, title, local.type);
        return true;
    } catch (e) {
        console.error("Failed to create conflict copy for purged item", local.id, e);
        if (!local.sync_error) {
            local.sync_error = "pending_purge_conflict";
            await db.put("items", local);
        }
        return false;
    }
}

/** UI: refetch the tree and force a reload of the open note, even in a dirty editor. */
function notifyConflictResolved(originalId: string | undefined, conflictId: string): void {
    if (typeof window === "undefined") return;
    emitVaultItemsChanged();
    if (originalId) {
        window.dispatchEvent(
            new CustomEvent(APP_EVENTS.noteForceReload, { detail: { noteId: originalId } }),
        );
    }
    window.dispatchEvent(
        new CustomEvent(APP_EVENTS.noteForceReload, { detail: { noteId: conflictId } }),
    );
}

/**
 * A conflict copy built from an already-decrypted payload (multi-tab, say: the user's changes, which
 * must not overwrite the IDB original). The same contract as createLocalConflictCopy: a new id, a
 * new IK, and conflict_of.
 */
export async function createLocalConflictCopyFromPayload(
    originalItem: LocalItem,
    payloadIn: Record<string, unknown>,
): Promise<{ item: LocalItem; title: string }> {
    const payload: Record<string, unknown> = { ...payloadIn };

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    if (originalItem.type === "file") {
        payload.name = `${(payload.name as string) || "file"} [Conflict ${timestamp}]`;
    } else {
        payload.title = `${payload.title || "Untitled"} [Conflict ${timestamp}]`;
    }
    payload.conflict_of = originalItem.id;

    if (originalItem.type === "note" && typeof payload.content === "string") {
        payload.content = stripAllFileRefsFromHtml(payload.content).html;
    }

    const newId = uuidv7();
    const { encryptedItemKey, itemKeyNonce } = await generateItemKeyTask(newId);
    const { encrypted_payload, payload_nonce } = await encryptItemPayloadToBase64(
        newId,
        1,
        payload,
    );
    const parentId = await resolveConflictParentId(originalItem.parent_id);

    const conflictItem: LocalItem = {
        id: newId,
        type: originalItem.type,
        parent_id: parentId,
        encrypted_payload,
        payload_nonce,
        encrypted_item_key: toBase64(new Uint8Array(encryptedItemKey)),
        item_key_nonce: toBase64(new Uint8Array(itemKeyNonce)),
        sort_order: originalItem.sort_order,
        version: 1,
        dirty: true,
        conflict_of: originalItem.id,
        created_at: nowSec(),
        updated_at: nowSec(),
    };

    const doc = toSearchDoc({ id: newId, type: originalItem.type }, payload);
    void addOrUpdateDoc(doc).catch((e) => console.warn("Failed to index conflict copy", e));

    return { item: conflictItem, title: doc.title };
}

/**
 * Creates a local conflict copy of an item:
 * 1. Decrypts the payload through the SharedWorker
 * 2. Prefixes the title with "[Conflict YYYY-MM-DD HH:MM]"
 * 3. Generates a new Item Key and re-encrypts
 * 4. Returns { item, title } — the prefixed title goes into the toast without decrypting again
 */
export async function createLocalConflictCopy(
    localItem: LocalItem,
): Promise<{ item: LocalItem; title: string }> {
    const payload = await decryptItemPayload<Record<string, unknown>>(localItem);
    return createLocalConflictCopyFromPayload(localItem, payload);
}

/**
 * The outcome of {@link replaceConflictCopyContent}. `unavailable` = the copy is gone, was resolved or
 * was written meanwhile — the caller must keep the text some other way (a new copy), never drop it.
 */
export type ConflictCopyWrite = "written" | "unchanged" | "unavailable";

/**
 * One conflict = one copy. A push 409 has already put this editor's last saved version into
 * a conflict copy of `originalId`; later text from the same editor goes into THAT copy rather than a
 * second one. Only `content` and `contentTitle` move — the "[Conflict …]" title, `conflict_of` and
 * the rest of the payload stay. Re-encrypted under the copy's own Item Key (no re-key), the embeds
 * stripped as when the copy was made (1:1 — a sibling must not share a file).
 *
 * CRYPTO BEFORE THE IDB TRANSACTION, and a CAS on the copy's ciphertext inside it.
 */
export async function replaceConflictCopyContent(
    copyId: string,
    originalId: string,
    contentTitle: string,
    html: string,
): Promise<ConflictCopyWrite> {
    const db = await getDB();
    const copy = await db.get("items", copyId);
    if (
        !copy ||
        copy.type !== "note" ||
        copy.conflict_of !== originalId ||
        copy.deleted_at != null ||
        copy.purged_at != null
    ) {
        return "unavailable";
    }

    const payload = await decryptItemPayload<Record<string, unknown>>(copy);
    const content = stripAllFileRefsFromHtml(html).html;
    if (payload.content === content && payload.contentTitle === contentTitle) return "unchanged";
    payload.content = content;
    payload.contentTitle = contentTitle;

    await addCachedItemKey(
        copyId,
        fromBase64(copy.encrypted_item_key || ""),
        fromBase64(copy.item_key_nonce || ""),
    );
    const { encrypted_payload, payload_nonce } = await encryptItemPayloadToBase64(
        copyId,
        copy.version,
        payload,
    );

    const tx = db.transaction("items", "readwrite");
    const store = tx.objectStore("items");
    const fresh = await store.get(copyId);
    if (!fresh || fresh.encrypted_payload !== copy.encrypted_payload || fresh.conflict_of == null) {
        await tx.done;
        return "unavailable";
    }
    fresh.encrypted_payload = encrypted_payload;
    fresh.payload_nonce = payload_nonce;
    touchForPush(fresh);
    await store.put(fresh);
    await tx.done;

    await enqueueMutation(copyId, "upsert");
    void addOrUpdateDoc(toSearchDoc({ id: copyId, type: "note" }, payload)).catch((e) =>
        console.warn("Failed to re-index conflict copy", e),
    );
    return "written";
}

/**
 * The conflict copy specific to files. Unlike notes, files cannot be re-keyed, because
 * their chunks are already encrypted with the original Item Key. Instead:
 * 1. Decrypt the metadata payload and prefix the name field with "[Conflict …]".
 * 2. Re-encrypt the modified payload under the SAME Item Key (merely cached under the new item ID).
 * 3. Copy chunk_set_id, chunk_count and ciphertext_size unchanged — the blob is shared.
 */
export async function createLocalFileConflictCopy(
    localItem: LocalItem,
): Promise<{ item: LocalItem; title: string }> {
    const payload = await decryptItemPayload<Record<string, unknown>>(localItem);

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    payload.name = `${(payload.name as string) || "file"} [Conflict ${timestamp}]`;
    // The cross-device marker: it lives inside the ciphertext so it survives the server round trip.
    payload.conflict_of = localItem.id;

    const newId = uuidv7();
    // Re-wrap under the new id's AAD (the same raw IK — the chunks stay readable).
    // An ADD_ITEM_KEY(newId, oldWrap) would fail on an invalid tag, because the wrap is bound to originalId.
    const rewrapped = await cloneItemKeyTask(
        localItem.id,
        newId,
        fromBase64(localItem.encrypted_item_key || ""),
        fromBase64(localItem.item_key_nonce || ""),
    );
    // A conflict copy is a NEW item (version=1).
    const { encrypted_payload, payload_nonce } = await encryptItemPayloadToBase64(
        newId,
        1,
        payload,
    );
    const parentId = await resolveConflictParentId(localItem.parent_id);

    const conflictItem: LocalItem = {
        id: newId,
        type: "file",
        parent_id: parentId,
        encrypted_payload,
        payload_nonce,
        // Re-wrapped under newId's AAD; the raw IK is the same as the original's (the chunk set is shared).
        encrypted_item_key: toBase64(rewrapped.encryptedItemKey),
        item_key_nonce: toBase64(rewrapped.itemKeyNonce),
        // The same blob — the immutable chunk set is shared, with no bytes copied.
        chunk_set_id: localItem.chunk_set_id,
        chunk_count: localItem.chunk_count,
        ciphertext_size: localItem.ciphertext_size,
        sort_order: localItem.sort_order,
        version: 1,
        dirty: true,
        conflict_of: localItem.id,
        created_at: nowSec(),
        updated_at: nowSec(),
    };

    void addOrUpdateDoc(toSearchDoc({ id: newId, type: "file" }, payload)).catch((e) =>
        console.warn("Failed to index file conflict copy", e),
    );

    return { item: conflictItem, title: payload.name as string };
}

/**
 * Compares a local item with a server item (payload plus metadata).
 * If they are identical, the engine may skip the conflict copy and accept the server's state.
 *
 * The metadata (parent_id, sort_order, deleted_at) and the payload fields (starred/color/icon/…)
 * MUST take part in the comparison — otherwise "identical → accept server" silently loses a trash,
 * a move or a star whenever the content happens to match (an offline trash against an online star,
 * for instance).
 */
export async function isConflictIdentical(
    localItem: LocalItem,
    serverItem: LocalItem,
): Promise<boolean> {
    try {
        // Wire / IDB metadata (not in the ciphertext)
        if (localItem.parent_id !== serverItem.parent_id) return false;
        if (localItem.sort_order !== serverItem.sort_order) return false;
        if ((localItem.deleted_at ?? null) !== (serverItem.deleted_at ?? null)) return false;
        if ((localItem.purged_at ?? null) !== (serverItem.purged_at ?? null)) return false;

        const lp = await decryptItemPayload<Record<string, unknown>>(localItem);
        const sp = await decryptItemPayload<Record<string, unknown>>(serverItem);

        if (localItem.type === "file") {
            // Every field a user can edit has to take part, or "identical" silently discards their
            // change: name, description (editable in the detail panel) and the chunk set.
            // Note: this is a best-effort check that does not download every file chunk. It can miss
            // the case where two versions have identical content but were uploaded afresh under two
            // different chunk set IDs. That is an acceptable trade-off for performance.
            return (
                lp.name === sp.name &&
                lp.description === sp.description &&
                lp.mime === sp.mime &&
                localItem.chunk_set_id === serverItem.chunk_set_id
            );
        }

        // note / folder — the content plus the remaining payload fields that are re-encrypted separately
        return (
            lp.title === sp.title &&
            lp.description === sp.description &&
            lp.content === sp.content &&
            lp.contentTitle === sp.contentTitle &&
            lp.starred === sp.starred &&
            lp.color === sp.color &&
            lp.icon === sp.icon &&
            lp.outlineVisible === sp.outlineVisible
        );
    } catch (_e) {
        // If decryption fails (a locked vault, a wrong key), ignore it and treat them as unequal
        return false;
    }
}

/** A conflict copy by item type — files are NOT re-keyed. */
export function createConflictCopyForItem(
    localItem: LocalItem,
): Promise<{ item: LocalItem; title: string }> {
    return localItem.type === "file"
        ? createLocalFileConflictCopy(localItem)
        : createLocalConflictCopy(localItem);
}

// Matches the format the create helpers generate: " [Conflict YYYY-MM-DD HH:MM]"
const CONFLICT_SUFFIX_RE = / \[Conflict \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/;

/** Removes one trailing "[Conflict …]" marker from a title or name. Idempotent on clean titles. */
export function stripConflictSuffix(title: string): string {
    return (title ?? "").replace(CONFLICT_SUFFIX_RE, "");
}

/**
 * Conflict resolution that propagates the decision to the server rather than staying local.
 *
 * - `keep_server`: discard the local copy everywhere — a local delete plus a server delete mutation.
 * - `keep_local` ("Keep Offline Version"): MERGE BACK — write the copy's content into the ORIGINAL
 *    item (a stable id, so both devices converge on the same note) and delete the copy everywhere.
 *    The note's identity therefore does not change: both browsers end up on originalId with the
 *    offline content, not on a separate v1 copy. The fallback, when the original no longer exists
 *    locally: promote the copy to the canonical item (dropping the suffix). Previously `keep_local`
 *    trashed the original and promoted the copy → the identity changed and the other device never
 *    converged (the bug: "the other browser keeps the old html, version v1").
 * - `keep_both`: promote the copy as a separate sibling (keeping the suffix) and leave the original
 *    alone.
 *
 * CRYPTO BEFORE THE IDB TRANSACTION: `decryptItemPayload` and `encryptItemPayloadToBase64` are async
 * Worker calls — they must not sit inside an IDB transaction (the auto-commit trap).
 * RE-KEYING IS FORBIDDEN: a file copy shares a chunk set encrypted with the original IK;
 * reuse existing cached key, not `generateItemKeyTask`.
 */
export async function resolveConflictInDB(
    conflictId: string,
    originalId: string | undefined,
    action: "keep_local" | "keep_server" | "keep_both",
): Promise<void> {
    const db = await getDB();
    const copy = await db.get("items", conflictId);
    if (!copy) return;

    if (action === "keep_server") {
        // Discard the local copy everywhere — a server delete supersedes any pending upsert (the
        // mutation queue is keyed by id). purgeOwnedItem on an unknown id is a no-op, so this is safe
        // even for a copy that never reached the server.
        await db.delete("items", conflictId);
        void removeDoc(conflictId).catch(() => {});
        await enqueueMutation(conflictId, "delete");
        // The original (the server's state) has to stay clean — otherwise an open dirty editor can
        // autosave the offline HTML back over the server version.
        if (originalId) {
            const orig = await db.get("items", originalId);
            if (orig?.dirty) {
                orig.dirty = false;
                await db.put("items", orig);
            }
        }
        conflictStore.removeResolved(conflictId);
        notifyConflictResolved(originalId, conflictId);
        return;
    }

    // 1) CRYPTO FIRST — never inside an IDB transaction. Decrypt the copy's offline content.
    const payload = await decryptItemPayload<Record<string, unknown>>(copy);
    delete payload.conflict_of; // remove the cross-device marker from the ciphertext

    const original =
        action === "keep_local" && originalId ? await db.get("items", originalId) : undefined;

    if (action === "keep_local" && original && originalId) {
        // MERGE BACK: the copy's content → the ORIGINAL (a stable id). Drop the "[Conflict …]"
        // suffix, because it becomes the canonical title.
        if (copy.type === "file") {
            payload.name = stripConflictSuffix(payload.name as string);
        } else {
            payload.title = stripConflictSuffix(payload.title as string);
            // The conflict copy stripped the embeds (1:1 — a sibling must not share a file). The
            // merge-back writes into the ORIGINAL, which still owns the READY files — so restore the
            // encFile markup from the original that the offline HTML is missing (otherwise
            // keep_local deletes every attachment).
            if (copy.type === "note" && typeof payload.content === "string") {
                try {
                    const origPayload = await decryptItemPayload<Record<string, unknown>>(original);
                    if (typeof origPayload.content === "string") {
                        payload.content = reattachEmbedsFromOriginal(
                            payload.content,
                            origPayload.content,
                        );
                    }
                } catch {
                    // Decrypting the original failed — keep the offline content (stripped) rather
                    // than failing the whole resolution; the user still sees the files in /files.
                }
            }
        }

        // Encrypt under the ORIGINAL's Item Key, not the copy's — make sure it is cached in the
        // worker (the copy and the original have different IKs). buildPayloadAad ignores the version
        // (the AAD is the itemId).
        await addCachedItemKey(
            originalId,
            fromBase64(original.encrypted_item_key || ""),
            fromBase64(original.item_key_nonce || ""),
        );
        const { encrypted_payload, payload_nonce } = await encryptItemPayloadToBase64(
            originalId,
            original.version,
            payload,
        );

        // 2) IDB WRITES — a short transaction, no worker await inside.
        const tx = db.transaction("items", "readwrite");
        const store = tx.objectStore("items");
        const freshOriginal = await store.get(originalId);
        if (freshOriginal) {
            freshOriginal.encrypted_payload = encrypted_payload;
            freshOriginal.payload_nonce = payload_nonce;
            // For a file, the payload carries its own chunkSetId/chunks manifest (the download reads
            // it solely from there, never from item.chunk_set_id) — so copy the DB metadata from the
            // copy to keep it consistent with the payload just written; otherwise the original
            // references one blob in its DB column while the payload manifest names another (garbage,
            // or a failed decrypt, on download).
            if (copy.type === "file") {
                freshOriginal.chunk_set_id = copy.chunk_set_id;
                freshOriginal.chunk_count = copy.chunk_count;
                freshOriginal.ciphertext_size = copy.ciphertext_size;
            }
            freshOriginal.dirty = true;
            freshOriginal.localRev = (freshOriginal.localRev || 0) + 1;
            await store.put(freshOriginal);
        }
        await store.delete(conflictId); // the copy disappears — its content now lives in the original
        await tx.done;

        // 3) PROPAGATION: an upsert of the original (the other device pulls the offline content
        //    under the same id), and a delete of the copy everywhere (the other device removes it
        //    from its inbox and tree).
        await enqueueMutation(originalId, "upsert");
        await enqueueMutation(conflictId, "delete");
        void removeDoc(conflictId).catch(() => {});

        void addOrUpdateDoc(toSearchDoc({ id: originalId, type: copy.type }, payload)).catch((e) =>
            console.warn("Failed to re-index resolved conflict", e),
        );

        conflictStore.removeResolved(conflictId);
        notifyConflictResolved(originalId, conflictId);
        return;
    }

    // keep_both (or keep_local with no live original): promote the copy to a separate canonical item.
    if (action === "keep_local") {
        // There is no live original — the copy becomes canonical, so drop the suffix.
        if (copy.type === "file") {
            payload.name = stripConflictSuffix(payload.name as string);
        } else {
            payload.title = stripConflictSuffix(payload.title as string);
        }
    }
    // keep_both keeps the suffix so the two siblings stay distinguishable.

    // Re-encrypt under the copy's EXISTING Item Key — not generateItemKeyTask (file copies share a
    // chunk set). buildPayloadAad ignores the version (the AAD is only the itemId), and the version
    // is unchanged.
    const { encrypted_payload, payload_nonce } = await encryptItemPayloadToBase64(
        conflictId,
        copy.version,
        payload,
    );

    // IDB WRITES — a short transaction, no worker await inside.
    const tx = db.transaction("items", "readwrite");
    const store = tx.objectStore("items");
    const freshCopy = await store.get(conflictId);
    if (!freshCopy) {
        await tx.done;
        return;
    }
    freshCopy.encrypted_payload = encrypted_payload;
    freshCopy.payload_nonce = payload_nonce;
    delete freshCopy.conflict_of; // drop the plaintext column → it leaves the inbox
    freshCopy.dirty = true;
    freshCopy.localRev = (freshCopy.localRev || 0) + 1;
    await store.put(freshCopy);
    await tx.done;

    // PROPAGATION + REINDEX + UI — outside the transaction (their own IDB operations / async).
    await enqueueMutation(conflictId, "upsert");

    void addOrUpdateDoc(toSearchDoc({ id: conflictId, type: copy.type }, payload)).catch((e) =>
        console.warn("Failed to re-index resolved conflict", e),
    );

    conflictStore.removeResolved(conflictId);
    notifyConflictResolved(originalId, conflictId);
}
