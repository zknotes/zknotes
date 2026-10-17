/**
 * Item payload codec — it retires the "addCachedItemKey + decryptPayloadTask + fromBase64"
 * boilerplate that had been copied across 10+ modules (sync, search, queries, export, files).
 *
 * It works EXCLUSIVELY through the crypto SharedWorker (the crypto-rpc RPC) — raw key material never
 * reaches this module, only base64 wire fields.
 */
import { fromBase64, toBase64 } from "$lib/core/utils/base64";
import {
    decryptManyPayloadsTask,
    decryptPayloadWithKeyTask,
    encryptPayloadTask,
} from "$lib/core/workers/crypto-rpc";

/**
 * The minimal set of an item's encrypted fields — both LocalItem and the server's wire form satisfy it.
 * `version` is forwarded to the worker but is not part of the AAD: `buildPayloadAad`
 * (shared/src/cryptography.ts) binds only the item id, because the server bumps the
 * version on every push and a version-bound tag would fail after each sync. The version passed for
 * a history snapshot therefore has no effect on decryption either.
 */
export interface EncryptedItemFields {
    id: string;
    version?: number | null;
    encrypted_payload?: string | null;
    payload_nonce?: string | null;
    encrypted_item_key?: string | null;
    item_key_nonce?: string | null;
}

/**
 * Decrypts an item's payload: caches the Item Key in the worker, then decrypts the payload — in
 * ONE worker round trip (decryptPayloadWithKeyTask), not two.
 * Throws if any field is wrong (a poly1305 tag mismatch — an AAD mismatch included).
 * CRITICAL: `id` must be the id the caller expects (the locally held one), never an id taken from
 * a server response — the AAD binds the payload to that id and nothing else.
 */
export async function decryptItemPayload<T>(item: EncryptedItemFields): Promise<T> {
    return decryptPayloadWithKeyTask<T>(
        item.id,
        fromBase64(item.encrypted_item_key || ""),
        fromBase64(item.item_key_nonce || ""),
        fromBase64(item.encrypted_payload || ""),
        fromBase64(item.payload_nonce || ""),
        item.version ?? 1,
    );
}

export interface DecryptManyResult<T> {
    id: string;
    data?: T;
    error?: Error;
}

/**
 * The batch variant of decryptItemPayload: N items in ONE worker round trip instead
 * of ADD_ITEM_KEY+DECRYPT_PAYLOAD per item (2×N postMessages). A single failure (a bad tag, an AAD
 * mismatch) does NOT bring the whole batch down — a per-item `error` comes back, the same "graceful
 * degrade" as the callers' old per-item try/catch (getTreeItems/getDeletedItems show
 * "Encrypted...").
 */
export async function decryptManyItemPayloads<T>(
    items: readonly EncryptedItemFields[],
): Promise<DecryptManyResult<T>[]> {
    if (items.length === 0) return [];
    const results = await decryptManyPayloadsTask<T>(
        items.map((item) => ({
            itemId: item.id,
            encryptedItemKey: fromBase64(item.encrypted_item_key || ""),
            itemKeyNonce: fromBase64(item.item_key_nonce || ""),
            ciphertext: fromBase64(item.encrypted_payload || ""),
            nonce: fromBase64(item.payload_nonce || ""),
            version: item.version ?? 1,
        })),
    );
    return results.map((r) => ({
        id: r.itemId,
        data: r.data,
        error: r.error ? new Error(r.error) : undefined,
    }));
}

/**
 * Encrypts a payload under item `id`'s (already cached) Item Key and returns the base64 wire fields
 * ready for LocalItem/the server.
 * The AAD is `id` alone — `version` is forwarded but `buildPayloadAad` ignores it.
 */
export async function encryptItemPayloadToBase64(
    id: string,
    version: number,
    payload: unknown,
): Promise<{ encrypted_payload: string; payload_nonce: string }> {
    const { ciphertext, nonce } = await encryptPayloadTask(id, payload, version);
    return {
        encrypted_payload: toBase64(new Uint8Array(ciphertext)),
        payload_nonce: toBase64(new Uint8Array(nonce)),
    };
}
