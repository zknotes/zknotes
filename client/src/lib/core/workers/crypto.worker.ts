/// <reference lib="webworker" />

import {
    assertKdfParamsFloor,
    buildChunkAad,
    buildItemKeyAad,
    buildPayloadAad,
    buildShareWrapAad,
    decryptChunk,
    decryptItemKey,
    decryptPayload,
    deriveShareKey,
    deriveSharePasswordKeys,
    encryptChunk,
    encryptItemKey,
    encryptPayload,
    generateSalt,
    generateShareLinkKey,
    type KdfParams,
    PRODUCTION_KDF_PARAMS,
    shareLinkKeyFromB64url,
    shareLinkKeyToB64url,
    zeroize,
} from "@zknotes/shared";
import MiniSearch from "minisearch";
import type { SearchDoc } from "./crypto-rpc";
import { ItemKeyCache } from "./item-key-cache";

// Type-assert self as a SharedWorkerGlobalScope or a DedicatedWorkerGlobalScope
const isSharedWorker =
    typeof SharedWorkerGlobalScope !== "undefined" && self instanceof SharedWorkerGlobalScope;

// State inside the worker scope — it holds the Vault Key, not the Encryption Key
let vaultKey: Uint8Array | null = null;
const itemKeys = new ItemKeyCache();

// ── The search index (plaintext tokens live only inside the worker) ──

const MINISEARCH_CONFIG = {
    fields: ["title", "content"],
    storeFields: ["id", "type", "title"],
    searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
    },
};

let miniSearch: MiniSearch<SearchDoc> | null = null;

/** The Share Key per shareId (only successfully unwrapped ones) — it saves re-deriving Argon2id per attachment. */
const shareKeyCache = new Map<string, Uint8Array>();

/**
 * Wipe every session secret, except that INIT immediately sets a new vaultKey.
 * itemKeys, the MiniSearch plaintext and shareKeyCache have to disappear on re-login or logout —
 * otherwise the previous account lingers inside the SharedWorker.
 */
function wipeSessionSecrets(): void {
    if (vaultKey) {
        zeroize(vaultKey);
        vaultKey = null;
    }
    itemKeys.clear();
    shareKeyCache.forEach((key) => {
        zeroize(key);
    });
    shareKeyCache.clear();
    miniSearch = null;
}

async function handleMessage(event: MessageEvent, port: MessagePort | typeof self) {
    const { id, type, payload } = event.data;

    try {
        switch (type) {
            case "INIT": {
                // Before a new VK, wipe everything left from the previous unlock (an account switch or re-login).
                wipeSessionSecrets();
                // payload.vaultKey arrives as a transferred ArrayBuffer (detached in the sender).
                vaultKey = new Uint8Array(payload.vaultKey as ArrayBuffer);
                port.postMessage({ id, type: "INIT_SUCCESS" });
                break;
            }

            case "PING": {
                port.postMessage({
                    id,
                    type: "PONG",
                    payload: { isUnlocked: vaultKey !== null },
                });
                break;
            }

            case "LOGOUT": {
                wipeSessionSecrets();
                port.postMessage({ id, type: "LOGOUT_SUCCESS" });
                break;
            }

            case "ADD_ITEM_KEY": {
                if (!vaultKey) throw new Error("Worker not unlocked");

                const { itemId, encryptedItemKey, itemKeyNonce } = payload;
                // The AAD binds the wrapped IK to the itemId — it prevents wrapped keys being
                // swapped between items.
                const ik = decryptItemKey(
                    new Uint8Array(encryptedItemKey),
                    new Uint8Array(itemKeyNonce),
                    vaultKey,
                    buildItemKeyAad(itemId),
                );

                itemKeys.set(itemId, ik);
                port.postMessage({ id, type: "ADD_ITEM_KEY_SUCCESS" });
                break;
            }

            case "CLONE_ITEM_KEY": {
                // A file conflict copy: the same raw IK (the chunks stay readable), but
                // the wrap has to be re-AAD'd under the new itemId — otherwise ADD_ITEM_KEY(newId,
                // oldWrap) → an invalid tag.
                if (!vaultKey) throw new Error("Worker not unlocked");
                const { fromItemId, toItemId, encryptedItemKey, itemKeyNonce } = payload as {
                    fromItemId: string;
                    toItemId: string;
                    encryptedItemKey: number[];
                    itemKeyNonce: number[];
                };
                const ik = decryptItemKey(
                    new Uint8Array(encryptedItemKey),
                    new Uint8Array(itemKeyNonce),
                    vaultKey,
                    buildItemKeyAad(fromItemId),
                );
                itemKeys.set(toItemId, ik);
                const wrapped = encryptItemKey(ik, vaultKey, buildItemKeyAad(toItemId));
                port.postMessage({
                    id,
                    type: "CLONE_ITEM_KEY_SUCCESS",
                    payload: {
                        encryptedItemKey: Array.from(wrapped.ciphertext),
                        itemKeyNonce: Array.from(wrapped.nonce),
                    },
                });
                break;
            }

            case "GENERATE_ITEM_KEY": {
                if (!vaultKey) throw new Error("Worker not unlocked");
                const { itemId } = payload;

                const ik = new Uint8Array(32);
                crypto.getRandomValues(ik);

                // The LRU eviction (the same cap as ADD_ITEM_KEY)
                itemKeys.set(itemId, ik);

                // Encrypt it with the Vault Key and AAD = itemId (it binds the wrapped IK to the
                // item).
                const cipherIk = encryptItemKey(ik, vaultKey, buildItemKeyAad(itemId));

                port.postMessage({
                    id,
                    type: "GENERATE_ITEM_KEY_SUCCESS",
                    payload: {
                        // Converted to a plain array, just in case, for the MessagePort
                        encryptedItemKey: Array.from(cipherIk.ciphertext),
                        itemKeyNonce: Array.from(cipherIk.nonce),
                    },
                });
                break;
            }

            case "ENCRYPT_PAYLOAD": {
                // The AAD binds only itemId — buildPayloadAad ignores `version`, which the server
                // bumps on every push. What must be trustworthy is the id: the one the client holds.
                const { itemId, data, version } = payload;
                const ik = itemKeys.get(itemId);
                if (!ik) throw new Error(`Item key not found for ${itemId}`);

                const aad = buildPayloadAad(itemId, version);
                const { ciphertext, nonce } = encryptPayload(data, ik, aad);
                port.postMessage({
                    id,
                    type: "ENCRYPT_PAYLOAD_SUCCESS",
                    payload: { ciphertext, nonce },
                });
                break;
            }

            case "ENCRYPT_PAYLOAD_NEW_KEY": {
                // Atomic: generate the IK, encrypt the payload with THAT key and wrap it — all in
                // one call. Bulk re-encryption (an import) must not rely on `itemKeys[id]` surviving
                // between GENERATE_ITEM_KEY and ENCRYPT_PAYLOAD: a parallel tree load (the same id on
                // an overwrite) or an eviction can overwrite the cache and untie the payload from its
                // key.
                if (!vaultKey) throw new Error("Worker not unlocked");
                const { itemId, data, version } = payload;

                const ik = new Uint8Array(32);
                crypto.getRandomValues(ik);

                // Both AADs are the id alone: the payload's through buildPayloadAad (the
                // version is ignored), the item key's through buildItemKeyAad.
                const payloadAad = buildPayloadAad(itemId, version);
                const { ciphertext, nonce } = encryptPayload(data, ik, payloadAad);
                const cipherIk = encryptItemKey(ik, vaultKey, buildItemKeyAad(itemId));

                // LRU; the values from this call are mutually consistent (no invalid tag).
                itemKeys.set(itemId, ik);

                port.postMessage({
                    id,
                    type: "ENCRYPT_PAYLOAD_NEW_KEY_SUCCESS",
                    payload: {
                        encryptedItemKey: Array.from(cipherIk.ciphertext),
                        itemKeyNonce: Array.from(cipherIk.nonce),
                        ciphertext,
                        nonce,
                    },
                });
                break;
            }

            case "DECRYPT_PAYLOAD": {
                // The AAD binds only itemId (buildPayloadAad ignores `version`); the caller must pass
                // the id it expects, never one taken from a server response.
                const { itemId, ciphertext, nonce, version } = payload;
                const ik = itemKeys.get(itemId);
                if (!ik) throw new Error(`Item key not found for ${itemId}`);

                const aad = buildPayloadAad(itemId, version);
                const data = decryptPayload(
                    new Uint8Array(ciphertext),
                    new Uint8Array(nonce),
                    ik,
                    aad,
                );

                port.postMessage({
                    id,
                    type: "DECRYPT_PAYLOAD_SUCCESS",
                    payload: { data },
                });
                break;
            }

            case "DECRYPT_PAYLOAD_WITH_KEY": {
                // The combined ADD_ITEM_KEY + DECRYPT_PAYLOAD op: one round trip
                // instead of two for the single-item decrypt path (autosave, rename/star/icon,
                // prune, cleanup all go through item-codec's decryptItemPayload).
                if (!vaultKey) throw new Error("Worker not unlocked");
                const { itemId, encryptedItemKey, itemKeyNonce, ciphertext, nonce, version } =
                    payload;

                const ik = decryptItemKey(
                    new Uint8Array(encryptedItemKey),
                    new Uint8Array(itemKeyNonce),
                    vaultKey,
                    buildItemKeyAad(itemId),
                );
                itemKeys.set(itemId, ik);

                const aad = buildPayloadAad(itemId, version);
                const data = decryptPayload(
                    new Uint8Array(ciphertext),
                    new Uint8Array(nonce),
                    ik,
                    aad,
                );

                port.postMessage({
                    id,
                    type: "DECRYPT_PAYLOAD_WITH_KEY_SUCCESS",
                    payload: { data },
                });
                break;
            }

            case "DECRYPT_MANY": {
                // The batch variant of ADD_ITEM_KEY+DECRYPT_PAYLOAD: N items in ONE
                // postMessage round trip instead of 2×N. A single failure (a bad tag or AAD) does NOT
                // break the batch — the other items in the series still decrypt, exactly as with the
                // old per-item try/catch at the call site.
                if (!vaultKey) throw new Error("Worker not unlocked");
                const { items } = payload as {
                    items: Array<{
                        itemId: string;
                        encryptedItemKey: number[];
                        itemKeyNonce: number[];
                        ciphertext: number[];
                        nonce: number[];
                        version: number;
                    }>;
                };

                const results = items.map((it) => {
                    try {
                        const ik = decryptItemKey(
                            new Uint8Array(it.encryptedItemKey),
                            new Uint8Array(it.itemKeyNonce),
                            vaultKey as Uint8Array,
                            buildItemKeyAad(it.itemId),
                        );
                        itemKeys.set(it.itemId, ik);

                        const aad = buildPayloadAad(it.itemId, it.version);
                        const data = decryptPayload(
                            new Uint8Array(it.ciphertext),
                            new Uint8Array(it.nonce),
                            ik,
                            aad,
                        );
                        return { itemId: it.itemId, data };
                    } catch (e) {
                        return {
                            itemId: it.itemId,
                            error: e instanceof Error ? e.message : "Unknown error",
                        };
                    }
                });

                port.postMessage({ id, type: "DECRYPT_MANY_SUCCESS", payload: { results } });
                break;
            }

            case "ENCRYPT_CHUNK": {
                // Encrypting a file chunk. The Item Key is cached under the file
                // item's id; the AAD binds chunk_set_id plus the position. encryptChunk generates a
                // fresh nonce per call. plaintext arrives as a transferred ArrayBuffer.
                const { itemId, chunkSetId, chunkIndex, totalChunks, plaintext } = payload;
                const ik = itemKeys.get(itemId);
                if (!ik) throw new Error(`Item key not found for ${itemId}`);

                const aad = buildChunkAad(chunkSetId, chunkIndex, totalChunks);
                const { ciphertext, nonce } = encryptChunk(new Uint8Array(plaintext), ik, aad);

                const exactCiphertext = ciphertext.slice();
                port.postMessage(
                    {
                        id,
                        type: "ENCRYPT_CHUNK_SUCCESS",
                        payload: { ciphertext: exactCiphertext.buffer, nonce },
                    },
                    [exactCiphertext.buffer],
                );
                break;
            }

            case "DECRYPT_CHUNK": {
                const { itemId, chunkSetId, chunkIndex, totalChunks, ciphertext, nonce } = payload;
                const ik = itemKeys.get(itemId);
                if (!ik) throw new Error(`Item key not found for ${itemId}`);

                const aad = buildChunkAad(chunkSetId, chunkIndex, totalChunks);
                const plaintext = decryptChunk(
                    new Uint8Array(ciphertext),
                    new Uint8Array(nonce),
                    ik,
                    aad,
                );

                const exactPlaintext = plaintext.slice();
                port.postMessage(
                    {
                        id,
                        type: "DECRYPT_CHUNK_SUCCESS",
                        payload: { plaintext: exactPlaintext.buffer },
                    },
                    [exactPlaintext.buffer],
                );
                break;
            }

            case "DECRYPT_CHUNK_WITH_KEY": {
                const {
                    itemKey: itemKeyBytes,
                    chunkSetId,
                    chunkIndex,
                    totalChunks,
                    ciphertext,
                    nonce,
                } = payload as {
                    itemKey: number[];
                    chunkSetId: string;
                    chunkIndex: number;
                    totalChunks: number;
                    ciphertext: ArrayBuffer;
                    nonce: number[];
                };
                const ik = new Uint8Array(itemKeyBytes);
                const aad = buildChunkAad(chunkSetId, chunkIndex, totalChunks);
                const plaintext = decryptChunk(
                    new Uint8Array(ciphertext),
                    new Uint8Array(nonce),
                    ik,
                    aad,
                );
                zeroize(ik);

                const exactPlaintext = plaintext.slice();
                port.postMessage(
                    {
                        id,
                        type: "DECRYPT_CHUNK_WITH_KEY_SUCCESS",
                        payload: { plaintext: exactPlaintext.buffer },
                    },
                    [exactPlaintext.buffer],
                );
                break;
            }

            case "BUILD_INDEX": {
                const { docs } = payload as { docs: SearchDoc[] };
                miniSearch = new MiniSearch<SearchDoc>(MINISEARCH_CONFIG);
                if (docs.length > 0) {
                    miniSearch.addAll(docs);
                }
                port.postMessage({
                    id,
                    type: "BUILD_INDEX_SUCCESS",
                    payload: { count: docs.length },
                });
                break;
            }

            case "ADD_INDEX_DOC": {
                if (!miniSearch) {
                    miniSearch = new MiniSearch<SearchDoc>(MINISEARCH_CONFIG);
                }
                const { doc } = payload as { doc: SearchDoc };
                if (miniSearch.has(doc.id)) {
                    miniSearch.replace(doc);
                } else {
                    miniSearch.add(doc);
                }
                port.postMessage({ id, type: "ADD_INDEX_DOC_SUCCESS" });
                break;
            }

            case "ADD_INDEX_DOCS": {
                // The batch variant of ADD_INDEX_DOC: N docs in ONE postMessage
                // round trip instead of one per doc — used by the pull, which can touch hundreds of
                // items on a single page.
                if (!miniSearch) {
                    miniSearch = new MiniSearch<SearchDoc>(MINISEARCH_CONFIG);
                }
                const { docs } = payload as { docs: SearchDoc[] };
                for (const doc of docs) {
                    if (miniSearch.has(doc.id)) {
                        miniSearch.replace(doc);
                    } else {
                        miniSearch.add(doc);
                    }
                }
                port.postMessage({ id, type: "ADD_INDEX_DOCS_SUCCESS" });
                break;
            }

            case "REMOVE_INDEX_DOC": {
                const { docId } = payload as { docId: string };
                if (miniSearch?.has(docId)) {
                    miniSearch.discard(docId);
                }
                port.postMessage({ id, type: "REMOVE_INDEX_DOC_SUCCESS" });
                break;
            }

            case "SEARCH_INDEX": {
                if (!miniSearch) {
                    port.postMessage({
                        id,
                        type: "SEARCH_INDEX_SUCCESS",
                        payload: { results: [] },
                    });
                    break;
                }
                const { query, limit } = payload as { query: string; limit?: number };
                const raw = miniSearch.search(query);
                const sliced = typeof limit === "number" ? raw.slice(0, limit) : raw;
                const results = sliced.map((r) => {
                    const doc = r as unknown as SearchDoc & { score: number };
                    return {
                        id: doc.id,
                        type: doc.type,
                        title: doc.title,
                        score: doc.score,
                    };
                });
                port.postMessage({
                    id,
                    type: "SEARCH_INDEX_SUCCESS",
                    payload: { results },
                });
                break;
            }

            case "SERIALIZE_INDEX": {
                if (!vaultKey) throw new Error("Worker not unlocked");
                if (!miniSearch) {
                    port.postMessage({
                        id,
                        type: "SERIALIZE_INDEX_SUCCESS",
                        payload: { empty: true },
                    });
                    break;
                }

                const json = JSON.stringify(miniSearch.toJSON());

                // A random per-blob Item Key, wrapped with the Vault Key (the same pattern as a note's IK)
                const ik = new Uint8Array(32);
                crypto.getRandomValues(ik);

                const { ciphertext: indexCiphertext, nonce: indexNonce } = encryptPayload(
                    { i: json },
                    ik,
                );
                const cipherIk = encryptPayload({ k: Array.from(ik) }, vaultKey);
                zeroize(ik);

                const ctBuf = indexCiphertext.buffer.slice(
                    indexCiphertext.byteOffset,
                    indexCiphertext.byteOffset + indexCiphertext.byteLength,
                ) as ArrayBuffer;
                const nonceBuf = indexNonce.buffer.slice(
                    indexNonce.byteOffset,
                    indexNonce.byteOffset + indexNonce.byteLength,
                ) as ArrayBuffer;
                const ikCtBuf = cipherIk.ciphertext.buffer.slice(
                    cipherIk.ciphertext.byteOffset,
                    cipherIk.ciphertext.byteOffset + cipherIk.ciphertext.byteLength,
                ) as ArrayBuffer;
                const ikNonceBuf = cipherIk.nonce.buffer.slice(
                    cipherIk.nonce.byteOffset,
                    cipherIk.nonce.byteOffset + cipherIk.nonce.byteLength,
                ) as ArrayBuffer;

                port.postMessage(
                    {
                        id,
                        type: "SERIALIZE_INDEX_SUCCESS",
                        payload: {
                            empty: false,
                            ciphertext: ctBuf,
                            nonce: nonceBuf,
                            ikCiphertext: ikCtBuf,
                            ikNonce: ikNonceBuf,
                        },
                    },
                    [ctBuf, nonceBuf, ikCtBuf, ikNonceBuf],
                );
                break;
            }

            case "WRAP_ITEM_KEY_FOR_SHARE": {
                const {
                    shareId,
                    itemId,
                    password,
                    kdfSalt: kdfSaltBytes,
                    kdfParams,
                    fragmentKeyB64url: reuseFragmentKey,
                } = payload as {
                    shareId: string;
                    itemId: string;
                    password?: string;
                    kdfSalt?: number[];
                    kdfParams?: KdfParams;
                    fragmentKeyB64url?: string;
                };

                // A snapshot of the bytes — never hold a live Map reference across an awaited
                // Argon2 (an LRU eviction zeroizes in place on the same buffer → a silent wrap with a
                // null key).
                const ikLive = itemKeys.get(itemId);
                if (!ikLive) throw new Error("Item key not available");
                const ik = new Uint8Array(ikLive);

                let linkKey: Uint8Array;
                if (reuseFragmentKey) {
                    linkKey = shareLinkKeyFromB64url(reuseFragmentKey);
                } else {
                    linkKey = generateShareLinkKey();
                }
                let shareAuthKeyB64: string | undefined;
                let kdfSaltB64: string | undefined;
                let kdfParamsOut: KdfParams | undefined;

                let shareKey: Uint8Array;
                try {
                    if (password) {
                        const salt = kdfSaltBytes ? new Uint8Array(kdfSaltBytes) : generateSalt();
                        if (kdfParams) {
                            assertKdfParamsFloor(kdfParams);
                        }
                        const params = kdfParams ?? PRODUCTION_KDF_PARAMS;
                        const { shareAuthKey, shareEncKey } = await deriveSharePasswordKeys(
                            password,
                            salt,
                            params,
                        );
                        shareKey = deriveShareKey(linkKey, shareEncKey);
                        shareAuthKeyB64 = btoa(String.fromCharCode(...shareAuthKey));
                        kdfSaltB64 = btoa(String.fromCharCode(...salt));
                        kdfParamsOut = params;
                        zeroize(shareEncKey);
                        zeroize(shareAuthKey);
                    } else {
                        shareKey = deriveShareKey(linkKey);
                    }

                    const wrapped = encryptItemKey(
                        ik,
                        shareKey,
                        buildShareWrapAad(shareId, itemId),
                    );
                    zeroize(shareKey);
                    zeroize(ik);

                    const fragmentKeyB64url = shareLinkKeyToB64url(linkKey);

                    port.postMessage({
                        id,
                        type: "WRAP_ITEM_KEY_FOR_SHARE_SUCCESS",
                        payload: {
                            wrappedItemKey: Array.from(wrapped.ciphertext),
                            itemKeyNonce: Array.from(wrapped.nonce),
                            fragmentKeyB64url,
                            shareAuthKeyB64,
                            kdfSaltB64,
                            kdfParams: kdfParamsOut,
                        },
                    });
                } catch (e) {
                    zeroize(ik);
                    throw e;
                }
                break;
            }

            case "DERIVE_SHARE_PASSWORD_KEYS": {
                const { password, kdfSaltB64, kdfParams } = payload as {
                    password: string;
                    kdfSaltB64: string;
                    kdfParams?: KdfParams;
                };
                if (!kdfSaltB64) {
                    throw new Error("Share password metadata incomplete");
                }
                if (kdfParams) {
                    assertKdfParamsFloor(kdfParams);
                }
                const params = kdfParams ?? PRODUCTION_KDF_PARAMS;
                const salt = Uint8Array.from(atob(kdfSaltB64), (c) => c.charCodeAt(0));
                const { shareAuthKey } = await deriveSharePasswordKeys(password, salt, params);
                const shareAuthKeyB64 = btoa(String.fromCharCode(...shareAuthKey));
                zeroize(shareAuthKey);
                port.postMessage({
                    id,
                    type: "DERIVE_SHARE_PASSWORD_KEYS_SUCCESS",
                    payload: { shareAuthKeyB64 },
                });
                break;
            }

            case "UNWRAP_AND_DECRYPT_SHARE": {
                const {
                    shareId,
                    sourceItemId,
                    wrappedItemKey,
                    itemKeyNonce,
                    encryptedPayload,
                    payloadNonce,
                    fragmentKeyB64url,
                    password,
                    kdfSaltB64,
                    kdfParams,
                    version,
                    retainItemKey,
                } = payload as {
                    shareId: string;
                    sourceItemId: string;
                    wrappedItemKey: number[];
                    itemKeyNonce: number[];
                    encryptedPayload: number[];
                    payloadNonce: number[];
                    fragmentKeyB64url: string;
                    password?: string;
                    kdfSaltB64?: string;
                    kdfParams?: KdfParams;
                    version: number;
                    retainItemKey?: boolean;
                };

                // Cached per shareId: with a password, every attachment would run Argon2id again
                // (~a second, 64 MB) — derive once and cache only after a successful unwrap (a wrong
                // password must never stick in the cache).
                let shareKey = shareKeyCache.get(shareId);
                const fromCache = shareKey !== undefined;
                if (!shareKey) {
                    const linkKey = shareLinkKeyFromB64url(fragmentKeyB64url);
                    if (password) {
                        if (!kdfSaltB64) {
                            throw new Error("Share password metadata incomplete");
                        }
                        if (kdfParams) {
                            assertKdfParamsFloor(kdfParams);
                        }
                        const params = kdfParams ?? PRODUCTION_KDF_PARAMS;
                        const saltBin = atob(kdfSaltB64);
                        const salt = Uint8Array.from(saltBin, (c) => c.charCodeAt(0));
                        const { shareEncKey } = await deriveSharePasswordKeys(
                            password,
                            salt,
                            params,
                        );
                        shareKey = deriveShareKey(linkKey, shareEncKey);
                        zeroize(shareEncKey);
                    } else {
                        shareKey = deriveShareKey(linkKey);
                    }
                    zeroize(linkKey);
                }

                let itemKey: Uint8Array;
                try {
                    itemKey = decryptItemKey(
                        new Uint8Array(wrappedItemKey),
                        new Uint8Array(itemKeyNonce),
                        shareKey,
                        buildShareWrapAad(shareId, sourceItemId),
                    );
                } catch (err) {
                    shareKeyCache.delete(shareId);
                    zeroize(shareKey);
                    throw err;
                }
                if (!fromCache) shareKeyCache.set(shareId, shareKey);

                const data = decryptPayload(
                    new Uint8Array(encryptedPayload),
                    new Uint8Array(payloadNonce),
                    itemKey,
                    buildPayloadAad(sourceItemId, version),
                );

                const itemKeyOut = retainItemKey ? Array.from(itemKey) : undefined;
                zeroize(itemKey);

                port.postMessage({
                    id,
                    type: "UNWRAP_AND_DECRYPT_SHARE_SUCCESS",
                    payload: { data, itemKey: itemKeyOut },
                });
                break;
            }

            case "LOAD_PERSISTED_INDEX": {
                if (!vaultKey) throw new Error("Worker not unlocked");
                const { ciphertext, nonce, ikCiphertext, ikNonce } = payload as {
                    ciphertext: ArrayBuffer;
                    nonce: ArrayBuffer;
                    ikCiphertext: ArrayBuffer;
                    ikNonce: ArrayBuffer;
                };

                const decIkPayload = decryptPayload<{ k: number[] }>(
                    new Uint8Array(ikCiphertext),
                    new Uint8Array(ikNonce),
                    vaultKey,
                );
                const ik = new Uint8Array(decIkPayload.k);

                const indexPayload = decryptPayload<{ i: string }>(
                    new Uint8Array(ciphertext),
                    new Uint8Array(nonce),
                    ik,
                );
                zeroize(ik);

                miniSearch = MiniSearch.loadJSON<SearchDoc>(indexPayload.i, MINISEARCH_CONFIG);
                const count = miniSearch.documentCount;

                port.postMessage({
                    id,
                    type: "LOAD_PERSISTED_INDEX_SUCCESS",
                    payload: { count },
                });
                break;
            }

            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        port.postMessage({ id, type: "ERROR", error: message });
    }
}

if (isSharedWorker) {
    (self as unknown as SharedWorkerGlobalScope).onconnect = (e: MessageEvent) => {
        const port = e.ports[0];
        port.onmessage = (event) => {
            void handleMessage(event, port);
        };
        port.start();
    };
} else {
    self.onmessage = (event) => {
        void handleMessage(event, self);
    };
}
