import type { HistorySnapshot } from "@zknotes/shared";
import { createSnapshot } from "$lib/core/api";
import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import { getDB } from "$lib/core/db";

interface HistoryMeta {
    localRevAtLastSnapshot: number;
    lastSnapshotAt: number;
}

async function getHistoryMeta(itemId: string): Promise<HistoryMeta> {
    const db = await getDB();
    const val = await db.get("metadata", `history_meta:${itemId}`);
    return (val as HistoryMeta) ?? { localRevAtLastSnapshot: -1, lastSnapshotAt: 0 };
}

async function setHistoryMeta(itemId: string, meta: HistoryMeta): Promise<void> {
    const db = await getDB();
    await db.put("metadata", meta, `history_meta:${itemId}`);
}

/**
 * Creates a snapshot of an item's current state if it has changed since the last one.
 * Safe to call when a note closes, on a route change, or from a manual trigger — it silently skips when nothing changed.
 */
export async function maybeCreateSnapshot(itemId: string): Promise<void> {
    const db = await getDB();
    const item = await db.get("items", itemId);
    if (item?.type !== "note") return;
    if (!item.encrypted_payload || !item.payload_nonce) return;
    if (!item.encrypted_item_key || !item.item_key_nonce) return;

    const meta = await getHistoryMeta(itemId);
    const currentRev = item.localRev ?? 0;

    // Skip when nothing has changed since the last snapshot
    if (currentRev <= meta.localRevAtLastSnapshot) return;

    // Write the metadata only AFTER a successful API call — otherwise a crash between the put and the
    // POST permanently "skips" a snapshot (currentRev <= meta with no real server row).
    // Several tabs may occasionally send two similar snapshots; thinOut tolerates that.
    try {
        await createSnapshot({
            item_id: itemId,
            encrypted_payload: item.encrypted_payload,
            payload_nonce: item.payload_nonce,
            encrypted_item_key: item.encrypted_item_key,
            item_key_nonce: item.item_key_nonce,
            item_version_at_snapshot: item.version ?? 1,
        });
        const newMeta: HistoryMeta = {
            localRevAtLastSnapshot: currentRev,
            lastSnapshotAt: Date.now(),
        };
        await setHistoryMeta(itemId, newMeta);
    } catch (e) {
        // Not fatal — the autosave carries on regardless; history is best-effort
        if (typeof navigator === "undefined" || navigator.onLine) {
            console.warn("[history] snapshot failed", e);
        }
    }
}

/**
 * Decrypts a snapshot of item `itemId` through the SharedWorker and returns the plaintext payload.
 *
 * `itemId` is the item whose history the caller shows — the id it holds locally, never the
 * server's `snapshot.item_id`. The Item Key wrap and the payload are both AAD-bound to the item id,
 * so decrypting under the local id is what stops a server from listing note B's snapshot (B's
 * ciphertext and wrapped Item Key, `item_id` = B) in note A's history, where Restore would write
 * B's content into A. A snapshot labelled with another id is refused before the worker is asked; one
 * relabelled to `itemId` fails the tag check.
 */
export async function decryptSnapshot<T>(itemId: string, snapshot: HistorySnapshot): Promise<T> {
    if (snapshot.item_id !== itemId) {
        throw new Error("Snapshot belongs to a different item");
    }
    // The AAD is the item id alone (buildPayloadAad ignores the version), so the version passed
    // below has no effect on decryption.
    return decryptItemPayload<T>({
        id: itemId,
        version: snapshot.item_version_at_snapshot,
        encrypted_payload: snapshot.encrypted_payload,
        payload_nonce: snapshot.payload_nonce,
        encrypted_item_key: snapshot.encrypted_item_key,
        item_key_nonce: snapshot.item_key_nonce,
    });
}
