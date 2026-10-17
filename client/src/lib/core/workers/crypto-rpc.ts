// The wrapper for interacting with the Crypto SharedWorker
import { type KdfParams, toPlainKdfParams } from "@zknotes/shared";
import { MINUTE_MS, SECOND_MS } from "$lib/core/utils/duration";

function workerKdfParams(params?: KdfParams): KdfParams | undefined {
    return params ? toPlainKdfParams(params) : undefined;
}

/**
 * The timeout for per-item RPCs that may queue behind long worker operations (BUILD_INDEX up to
 * 60 s, LOAD_PERSISTED_INDEX 30 s) — the worker is single-threaded, so messages are serialised. The
 * global #send default (2 s) was too short: on a cold start of a large vault,
 * ADD_ITEM_KEY/DECRYPT_PAYLOAD time out silently behind an index operation, and
 * getTreeItems/rebuildIndex swallow that as "Encrypted…" with no message to the user.
 */
const ITEM_RPC_TIMEOUT_MS = 20 * SECOND_MS;

/**
 * The first PING waits the usual 2 s — a worker that is idle answers at once. A timeout is not
 * "locked": a SharedWorker busy building the search index (a synchronous addAll) answers no tab for
 * seconds, so the caller asks once more, as patiently as a per-item RPC.
 */
const PING_TIMEOUT_MS = 2 * SECOND_MS;
export const PING_RETRY_TIMEOUT_MS = ITEM_RPC_TIMEOUT_MS;

/** A request the worker did not answer in time — it may be busy, not gone. */
export class WorkerRequestTimeoutError extends Error {
    constructor(type: string) {
        super(`Worker request timed out: ${type}`);
        this.name = "WorkerRequestTimeoutError";
    }
}

/** What a PING learns: whether the worker holds the Vault Key, or that it did not answer. */
export type WorkerPingStatus = boolean | "timeout";

export const toBytes = (u: Uint8Array): number[] => Array.from(u);
export const fromBytes = (a: number[]): Uint8Array => new Uint8Array(a);

export interface SearchDoc {
    id: string;
    type: "note" | "folder" | "file";
    title: string;
    content?: string;
}

export interface SearchHit {
    id: string;
    type: "note" | "folder" | "file";
    title: string;
    score: number;
}

export type SerializedIndexBlob =
    | { empty: true }
    | {
          empty: false;
          ciphertext: Uint8Array;
          nonce: Uint8Array;
          ikCiphertext: Uint8Array;
          ikNonce: Uint8Array;
      };

type WorkerReply<TPayload = unknown> = { payload: TPayload };

/** Creates the worker port — lifted out so tests can inject a fake port without vi.mock. */
export type CryptoWorkerFactory = () => MessagePort;

function defaultWorkerFactory(): MessagePort {
    if (typeof window === "undefined") {
        throw new Error("Cannot instantiate worker outside of browser environment");
    }
    try {
        // Try to use a SharedWorker
        const worker = new SharedWorker(new URL("./crypto.worker.ts", import.meta.url), {
            type: "module",
            // Changing the name forces a new worker when the INIT API changes (encryptionKey → vaultKey, say).
            name: "crypto-worker-v3",
        });
        worker.onerror = (err) => console.error("SharedWorker loading error:", err);
        return worker.port;
    } catch (_e) {
        // Fall back to a Dedicated Worker
        console.warn("SharedWorker not supported or failed, falling back to dedicated Worker");
        const worker = new Worker(new URL("./crypto.worker.ts", import.meta.url), {
            type: "module",
        });
        worker.onerror = (err) => console.error("Dedicated Worker loading error:", err);
        return worker as unknown as MessagePort;
    }
}

/**
 * The RPC client for the crypto worker — the only thing allowed to post messages on the port. The
 * worker is created LAZILY on the first real RPC call (#getPort) and never at construction: the module
 * is evaluated in SSR and test environments too, where no worker exists.
 */
export class CryptoWorkerClient {
    #port: MessagePort | null = null;
    #messageIdCounter = 0;
    readonly #pendingRequests = new Map<
        number,
        { resolve: (val: unknown) => void; reject: (err: Error) => void }
    >();
    readonly #workerFactory: CryptoWorkerFactory;

    // The constructor ONLY stores it — no side effect while the module is evaluated.
    constructor(workerFactory: CryptoWorkerFactory = defaultWorkerFactory) {
        this.#workerFactory = workerFactory;
    }

    #getPort(): MessagePort {
        if (!this.#port) {
            const port = this.#workerFactory();
            port.onmessage = (event) => this.#handleWorkerMessage(event);
            // A SharedWorker port needs start(); the dedicated Worker fallback (cast) has none.
            if (typeof port.start === "function") port.start();
            this.#port = port;
        }
        return this.#port;
    }

    #handleWorkerMessage(event: MessageEvent): void {
        const { id, type, error } = event.data;

        const promise = this.#pendingRequests.get(id);
        if (!promise) return; // Unknown, or already handled

        this.#pendingRequests.delete(id);

        if (type === "ERROR" || error) {
            promise.reject(new Error(error || "Worker error"));
        } else {
            // Return the whole event data, for maximum flexibility
            promise.resolve(event.data);
        }
    }

    #send<TPayload = unknown>(
        type: string,
        payload?: unknown,
        timeoutMs: number = 2000,
        transfer?: Transferable[],
    ): Promise<WorkerReply<TPayload>> {
        const port = this.#getPort();
        const id = ++this.#messageIdCounter;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pendingRequests.delete(id);
                reject(new WorkerRequestTimeoutError(type));
            }, timeoutMs);

            this.#pendingRequests.set(id, {
                resolve: (val) => {
                    clearTimeout(timeout);
                    resolve(val as WorkerReply<TPayload>);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                },
            });
            // Transferable buffers avoid copying multi-MB chunks across the worker boundary.
            // A transfer DETACHES the source — callers have to pass a fresh buffer.
            port.postMessage({ id, type, payload }, transfer ?? []);
        });
    }

    async ping(): Promise<boolean> {
        return (await this.pingStatus()) === true;
    }

    /** The PING that tells "locked" from "did not answer in time". */
    async pingStatus(timeoutMs: number = PING_TIMEOUT_MS): Promise<WorkerPingStatus> {
        try {
            const res = await this.#send<{ isUnlocked: boolean }>("PING", undefined, timeoutMs);
            return res.payload.isUnlocked;
        } catch (err) {
            return err instanceof WorkerRequestTimeoutError ? "timeout" : false;
        }
    }

    async unlock(vaultKeyBytes: Uint8Array): Promise<void> {
        // Transfer the underlying ArrayBuffer so the main-thread copy is detached (zeroized by the
        // runtime) instead of leaving a live copy inside the serialised postMessage payload.
        const buf = vaultKeyBytes.buffer.slice(
            vaultKeyBytes.byteOffset,
            vaultKeyBytes.byteOffset + vaultKeyBytes.byteLength,
        ) as ArrayBuffer;
        // 30 s instead of 2 s: on a cold start the SharedWorker needs time to load its modules;
        // INIT itself is fast, but waiting for the worker can take longer than 2 s.
        await this.#send("INIT", { vaultKey: buf }, 30 * SECOND_MS, [buf]);
    }

    async logout(): Promise<void> {
        // 2 s on purpose: the teardown logs a timeout and goes on, and the message stays in
        // the worker's queue — the key is dropped as soon as a long operation lets it through.
        await this.#send("LOGOUT");
    }

    async addCachedItemKey(
        itemId: string,
        encryptedItemKey: Uint8Array,
        itemKeyNonce: Uint8Array,
    ): Promise<void> {
        // Uint8Array structured-clones as a fast binary copy — no need to box it into a
        // plain number[] first.
        await this.#send(
            "ADD_ITEM_KEY",
            {
                itemId,
                encryptedItemKey,
                itemKeyNonce,
            },
            ITEM_RPC_TIMEOUT_MS,
        );
    }

    /**
     * A file conflict copy: unwrap the IK under the `fromItemId` AAD, cache the raw key
     * under `toItemId`, and re-wrap it under the `toItemId` AAD. Without this, ADD_ITEM_KEY(newId,
     * oldWrap) → an invalid tag.
     */
    async cloneItemKey(
        fromItemId: string,
        toItemId: string,
        encryptedItemKey: Uint8Array,
        itemKeyNonce: Uint8Array,
    ): Promise<{ encryptedItemKey: Uint8Array; itemKeyNonce: Uint8Array }> {
        const res = await this.#send<{ encryptedItemKey: number[]; itemKeyNonce: number[] }>(
            "CLONE_ITEM_KEY",
            {
                fromItemId,
                toItemId,
                encryptedItemKey: toBytes(encryptedItemKey),
                itemKeyNonce: toBytes(itemKeyNonce),
            },
            ITEM_RPC_TIMEOUT_MS,
        );
        return {
            encryptedItemKey: fromBytes(res.payload.encryptedItemKey),
            itemKeyNonce: fromBytes(res.payload.itemKeyNonce),
        };
    }

    async encryptPayload(
        itemId: string,
        data: unknown,
        version: number,
    ): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
        // The same reason as addCachedItemKey/decryptPayload: an autosave in flight while the worker
        // builds or loads the index must not silently lose the change to a 2 s timeout.
        const res = await this.#send<{ ciphertext: number[]; nonce: number[] }>(
            "ENCRYPT_PAYLOAD",
            { itemId, data, version },
            ITEM_RPC_TIMEOUT_MS,
        );
        return {
            ciphertext: fromBytes(res.payload.ciphertext),
            nonce: fromBytes(res.payload.nonce),
        };
    }

    /**
     * Atomically generates a new Item Key, encrypts the payload with it and returns the wrapped key
     * plus the ciphertext. Used for bulk re-encryption (an import), where nothing may rely on
     * `itemKeys[itemId]` surviving between separate GENERATE_ITEM_KEY and ENCRYPT_PAYLOAD calls (a
     * race on the shared cache).
     */
    async encryptPayloadWithNewKey(
        itemId: string,
        data: unknown,
        version: number,
    ): Promise<{
        encryptedItemKey: Uint8Array;
        itemKeyNonce: Uint8Array;
        ciphertext: Uint8Array;
        nonce: Uint8Array;
    }> {
        const res = await this.#send<{
            encryptedItemKey: number[];
            itemKeyNonce: number[];
            ciphertext: number[];
            nonce: number[];
        }>("ENCRYPT_PAYLOAD_NEW_KEY", { itemId, data, version }, ITEM_RPC_TIMEOUT_MS);
        return {
            encryptedItemKey: fromBytes(res.payload.encryptedItemKey),
            itemKeyNonce: fromBytes(res.payload.itemKeyNonce),
            ciphertext: fromBytes(res.payload.ciphertext),
            nonce: fromBytes(res.payload.nonce),
        };
    }

    async decryptPayload<T>(
        itemId: string,
        ciphertext: Uint8Array,
        nonce: Uint8Array,
        version: number,
    ): Promise<T> {
        const res = await this.#send<{ data: T }>(
            "DECRYPT_PAYLOAD",
            {
                itemId,
                ciphertext,
                nonce,
                version,
            },
            ITEM_RPC_TIMEOUT_MS,
        );
        return res.payload.data;
    }

    /**
     * The combined variant of addCachedItemKey+decryptPayload: a single postMessage
     * round trip instead of 2 — the worker unwraps the Item Key and decrypts the payload in one
     * message. Used by decryptItemPayload (item-codec.ts), the single-item decrypt path shared by
     * autosave, rename/star/icon saves, prune and cleanup.
     */
    async decryptPayloadWithKey<T>(
        itemId: string,
        encryptedItemKey: Uint8Array,
        itemKeyNonce: Uint8Array,
        ciphertext: Uint8Array,
        nonce: Uint8Array,
        version: number,
    ): Promise<T> {
        const res = await this.#send<{ data: T }>(
            "DECRYPT_PAYLOAD_WITH_KEY",
            { itemId, encryptedItemKey, itemKeyNonce, ciphertext, nonce, version },
            ITEM_RPC_TIMEOUT_MS,
        );
        return res.payload.data;
    }

    /**
     * The batch variant of decryptPayload: N items in ONE postMessage round trip
     * instead of ADD_ITEM_KEY+DECRYPT_PAYLOAD per item (2×N). A single failure does not throw — that
     * element carries an `error` and the other results stay valid (the caller performs the same
     * graceful degrade the per-item try/catch used to).
     */
    async decryptMany<T>(
        items: Array<{
            itemId: string;
            encryptedItemKey: Uint8Array;
            itemKeyNonce: Uint8Array;
            ciphertext: Uint8Array;
            nonce: Uint8Array;
            version: number;
        }>,
    ): Promise<Array<{ itemId: string; data?: T; error?: string }>> {
        const res = await this.#send<{
            results: Array<{ itemId: string; data?: T; error?: string }>;
        }>(
            "DECRYPT_MANY",
            {
                items: items.map((it) => ({
                    itemId: it.itemId,
                    encryptedItemKey: it.encryptedItemKey,
                    itemKeyNonce: it.itemKeyNonce,
                    ciphertext: it.ciphertext,
                    nonce: it.nonce,
                    version: it.version,
                })),
            },
            ITEM_RPC_TIMEOUT_MS,
        );
        return res.payload.results;
    }

    async generateItemKey(
        itemId: string,
    ): Promise<{ encryptedItemKey: number[]; itemKeyNonce: number[] }> {
        const res = await this.#send<{ encryptedItemKey: number[]; itemKeyNonce: number[] }>(
            "GENERATE_ITEM_KEY",
            { itemId },
            ITEM_RPC_TIMEOUT_MS,
        );
        return res.payload;
    }

    /**
     * Encrypts one file chunk inside the worker. `itemId` selects the cached Item Key;
     * the AAD binds `chunkSetId` plus the position. `plaintext.buffer` is TRANSFERRED (detached after
     * the call) — pass a fresh buffer (from `File.slice().arrayBuffer()`, for instance), and read it
     * again on a retry.
     */
    async encryptChunk(
        itemId: string,
        chunkSetId: string,
        chunkIndex: number,
        totalChunks: number,
        plaintext: Uint8Array,
    ): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
        const exactPlaintext = plaintext.slice();
        const res = await this.#send<{ ciphertext: number[]; nonce: number[] }>(
            "ENCRYPT_CHUNK",
            { itemId, chunkSetId, chunkIndex, totalChunks, plaintext: exactPlaintext.buffer },
            30 * SECOND_MS,
            [exactPlaintext.buffer],
        );
        return {
            ciphertext: fromBytes(res.payload.ciphertext),
            nonce: fromBytes(res.payload.nonce),
        };
    }

    /** Decrypts one file chunk inside the worker. `ciphertext.buffer` is TRANSFERRED (detached). */
    async decryptChunk(
        itemId: string,
        chunkSetId: string,
        chunkIndex: number,
        totalChunks: number,
        ciphertext: Uint8Array,
        nonce: Uint8Array,
    ): Promise<Uint8Array> {
        const exactCiphertext = ciphertext.slice();
        const res = await this.#send<{ plaintext: number[] }>(
            "DECRYPT_CHUNK",
            {
                itemId,
                chunkSetId,
                chunkIndex,
                totalChunks,
                ciphertext: exactCiphertext.buffer,
                nonce: toBytes(nonce),
            },
            30 * SECOND_MS,
            [exactCiphertext.buffer],
        );
        return fromBytes(res.payload.plaintext);
    }

    async buildIndex(docs: SearchDoc[]): Promise<{ count: number }> {
        const res = await this.#send<{ count: number }>("BUILD_INDEX", { docs }, MINUTE_MS);
        return res.payload;
    }

    async addIndexDoc(doc: SearchDoc): Promise<void> {
        await this.#send("ADD_INDEX_DOC", { doc }, ITEM_RPC_TIMEOUT_MS);
    }

    /** The batch variant of addIndexDoc: N docs in ONE postMessage round trip. */
    async addIndexDocs(docs: SearchDoc[]): Promise<void> {
        await this.#send("ADD_INDEX_DOCS", { docs }, ITEM_RPC_TIMEOUT_MS);
    }

    async removeIndexDoc(docId: string): Promise<void> {
        await this.#send("REMOVE_INDEX_DOC", { docId }, ITEM_RPC_TIMEOUT_MS);
    }

    async searchIndex(query: string, limit?: number): Promise<SearchHit[]> {
        const res = await this.#send<{ results: SearchHit[] }>(
            "SEARCH_INDEX",
            { query, limit },
            ITEM_RPC_TIMEOUT_MS,
        );
        return res.payload.results as SearchHit[];
    }

    async serializeIndex(): Promise<SerializedIndexBlob> {
        const res = await this.#send<{
            empty: boolean;
            ciphertext?: ArrayBuffer;
            nonce?: ArrayBuffer;
            ikCiphertext?: ArrayBuffer;
            ikNonce?: ArrayBuffer;
        }>("SERIALIZE_INDEX", undefined, 30 * SECOND_MS);
        if (res.payload.empty) return { empty: true };
        const { ciphertext, nonce, ikCiphertext, ikNonce } = res.payload;
        if (!ciphertext || !nonce || !ikCiphertext || !ikNonce) {
            throw new Error("SERIALIZE_INDEX returned incomplete payload");
        }
        return {
            empty: false,
            ciphertext: new Uint8Array(ciphertext),
            nonce: new Uint8Array(nonce),
            ikCiphertext: new Uint8Array(ikCiphertext),
            ikNonce: new Uint8Array(ikNonce),
        };
    }

    async loadPersistedIndex(blob: {
        ciphertext: Uint8Array;
        nonce: Uint8Array;
        ikCiphertext: Uint8Array;
        ikNonce: Uint8Array;
    }): Promise<{ count: number }> {
        const ctBuf = blob.ciphertext.buffer.slice(
            blob.ciphertext.byteOffset,
            blob.ciphertext.byteOffset + blob.ciphertext.byteLength,
        ) as ArrayBuffer;
        const nonceBuf = blob.nonce.buffer.slice(
            blob.nonce.byteOffset,
            blob.nonce.byteOffset + blob.nonce.byteLength,
        ) as ArrayBuffer;
        const ikCtBuf = blob.ikCiphertext.buffer.slice(
            blob.ikCiphertext.byteOffset,
            blob.ikCiphertext.byteOffset + blob.ikCiphertext.byteLength,
        ) as ArrayBuffer;
        const ikNonceBuf = blob.ikNonce.buffer.slice(
            blob.ikNonce.byteOffset,
            blob.ikNonce.byteOffset + blob.ikNonce.byteLength,
        ) as ArrayBuffer;

        const res = await this.#send<{ count: number }>(
            "LOAD_PERSISTED_INDEX",
            {
                ciphertext: ctBuf,
                nonce: nonceBuf,
                ikCiphertext: ikCtBuf,
                ikNonce: ikNonceBuf,
            },
            30 * SECOND_MS,
            [ctBuf, nonceBuf, ikCtBuf, ikNonceBuf],
        );
        return res.payload;
    }

    async sendDeriveSharePasswordKeys(args: {
        password: string;
        kdfSaltB64: string;
        kdfParams?: import("@zknotes/shared").KdfParams;
    }): Promise<{ shareAuthKeyB64: string }> {
        const res = await this.#send<{ shareAuthKeyB64: string }>(
            "DERIVE_SHARE_PASSWORD_KEYS",
            {
                password: args.password,
                kdfSaltB64: args.kdfSaltB64,
                kdfParams: workerKdfParams(args.kdfParams),
            },
            30 * SECOND_MS,
        );
        return res.payload;
    }

    async sendWrapItemKeyForShare(
        shareId: string,
        itemId: string,
        opts?: {
            password?: string;
            fragmentKeyB64url?: string;
            kdfSaltB64?: string;
            kdfParams?: import("@zknotes/shared").KdfParams;
        },
    ): Promise<{
        wrappedItemKey: Uint8Array;
        itemKeyNonce: Uint8Array;
        fragmentKeyB64url: string;
        shareAuthKeyB64?: string;
        kdfSaltB64?: string;
        kdfParams?: import("@zknotes/shared").KdfParams;
    }> {
        const res = await this.#send<{
            wrappedItemKey: number[];
            itemKeyNonce: number[];
            fragmentKeyB64url: string;
            shareAuthKeyB64?: string;
            kdfSaltB64?: string;
            kdfParams?: import("@zknotes/shared").KdfParams;
        }>(
            "WRAP_ITEM_KEY_FOR_SHARE",
            {
                shareId,
                itemId,
                password: opts?.password,
                fragmentKeyB64url: opts?.fragmentKeyB64url,
                kdfSalt: opts?.kdfSaltB64
                    ? Array.from(Uint8Array.from(atob(opts.kdfSaltB64), (c) => c.charCodeAt(0)))
                    : undefined,
                kdfParams: workerKdfParams(opts?.kdfParams),
            },
            30 * SECOND_MS,
        );
        return {
            wrappedItemKey: fromBytes(res.payload.wrappedItemKey),
            itemKeyNonce: fromBytes(res.payload.itemKeyNonce),
            fragmentKeyB64url: res.payload.fragmentKeyB64url,
            shareAuthKeyB64: res.payload.shareAuthKeyB64,
            kdfSaltB64: res.payload.kdfSaltB64,
            kdfParams: res.payload.kdfParams,
        };
    }

    async sendUnwrapAndDecryptShare<T>(args: {
        shareId: string;
        sourceItemId: string;
        wrappedItemKey: Uint8Array;
        itemKeyNonce: Uint8Array;
        encryptedPayload: Uint8Array;
        payloadNonce: Uint8Array;
        fragmentKeyB64url: string;
        password?: string;
        kdfSaltB64?: string;
        kdfParams?: import("@zknotes/shared").KdfParams;
        version?: number;
        retainItemKey?: boolean;
    }): Promise<{ data: T; itemKey?: Uint8Array }> {
        const res = await this.#send<{ data: T; itemKey?: number[] }>(
            "UNWRAP_AND_DECRYPT_SHARE",
            {
                shareId: args.shareId,
                sourceItemId: args.sourceItemId,
                wrappedItemKey: args.wrappedItemKey,
                itemKeyNonce: args.itemKeyNonce,
                encryptedPayload: args.encryptedPayload,
                payloadNonce: args.payloadNonce,
                fragmentKeyB64url: args.fragmentKeyB64url,
                password: args.password,
                kdfSaltB64: args.kdfSaltB64,
                kdfParams: workerKdfParams(args.kdfParams),
                version: args.version ?? 1,
                retainItemKey: args.retainItemKey,
            },
            30 * SECOND_MS,
        );
        return {
            data: res.payload.data,
            itemKey: res.payload.itemKey ? fromBytes(res.payload.itemKey) : undefined,
        };
    }

    async decryptChunkWithKey(
        itemKey: Uint8Array,
        chunkSetId: string,
        chunkIndex: number,
        totalChunks: number,
        ciphertext: Uint8Array,
        nonce: Uint8Array,
    ): Promise<Uint8Array> {
        const buf = ciphertext.buffer.slice(
            ciphertext.byteOffset,
            ciphertext.byteOffset + ciphertext.byteLength,
        ) as ArrayBuffer;
        const res = await this.#send<{ plaintext: ArrayBuffer }>(
            "DECRYPT_CHUNK_WITH_KEY",
            {
                itemKey: toBytes(itemKey),
                chunkSetId,
                chunkIndex,
                totalChunks,
                ciphertext: buf,
                nonce: toBytes(nonce),
            },
            30 * SECOND_MS,
            [buf],
        );
        return new Uint8Array(res.payload.plaintext);
    }
}

// ── The module singleton + the facade delegates (a stable public API) ──
// The construction has no side effect: the worker is spawned only on the first real RPC call.

export const cryptoWorker = new CryptoWorkerClient();

export function pingWorker(): Promise<boolean> {
    return cryptoWorker.ping();
}

export function pingWorkerStatus(timeoutMs?: number): Promise<WorkerPingStatus> {
    return cryptoWorker.pingStatus(timeoutMs);
}

export function unlockWorker(vaultKeyBytes: Uint8Array): Promise<void> {
    return cryptoWorker.unlock(vaultKeyBytes);
}

export function logoutWorker(): Promise<void> {
    return cryptoWorker.logout();
}

export function addCachedItemKey(
    itemId: string,
    encryptedItemKey: Uint8Array,
    itemKeyNonce: Uint8Array,
): Promise<void> {
    return cryptoWorker.addCachedItemKey(itemId, encryptedItemKey, itemKeyNonce);
}

export function cloneItemKeyTask(
    fromItemId: string,
    toItemId: string,
    encryptedItemKey: Uint8Array,
    itemKeyNonce: Uint8Array,
): Promise<{ encryptedItemKey: Uint8Array; itemKeyNonce: Uint8Array }> {
    return cryptoWorker.cloneItemKey(fromItemId, toItemId, encryptedItemKey, itemKeyNonce);
}

export function encryptPayloadTask(
    itemId: string,
    data: unknown,
    version: number,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
    return cryptoWorker.encryptPayload(itemId, data, version);
}

export function encryptPayloadWithNewKeyTask(
    itemId: string,
    data: unknown,
    version: number,
): Promise<{
    encryptedItemKey: Uint8Array;
    itemKeyNonce: Uint8Array;
    ciphertext: Uint8Array;
    nonce: Uint8Array;
}> {
    return cryptoWorker.encryptPayloadWithNewKey(itemId, data, version);
}

export function decryptPayloadTask<T>(
    itemId: string,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    version: number,
): Promise<T> {
    return cryptoWorker.decryptPayload<T>(itemId, ciphertext, nonce, version);
}

export function decryptPayloadWithKeyTask<T>(
    itemId: string,
    encryptedItemKey: Uint8Array,
    itemKeyNonce: Uint8Array,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    version: number,
): Promise<T> {
    return cryptoWorker.decryptPayloadWithKey<T>(
        itemId,
        encryptedItemKey,
        itemKeyNonce,
        ciphertext,
        nonce,
        version,
    );
}

export function decryptManyPayloadsTask<T>(
    items: Array<{
        itemId: string;
        encryptedItemKey: Uint8Array;
        itemKeyNonce: Uint8Array;
        ciphertext: Uint8Array;
        nonce: Uint8Array;
        version: number;
    }>,
): Promise<Array<{ itemId: string; data?: T; error?: string }>> {
    return cryptoWorker.decryptMany<T>(items);
}

export function generateItemKeyTask(
    itemId: string,
): Promise<{ encryptedItemKey: number[]; itemKeyNonce: number[] }> {
    return cryptoWorker.generateItemKey(itemId);
}

export function encryptChunkTask(
    itemId: string,
    chunkSetId: string,
    chunkIndex: number,
    totalChunks: number,
    plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array }> {
    return cryptoWorker.encryptChunk(itemId, chunkSetId, chunkIndex, totalChunks, plaintext);
}

export function decryptChunkTask(
    itemId: string,
    chunkSetId: string,
    chunkIndex: number,
    totalChunks: number,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
): Promise<Uint8Array> {
    return cryptoWorker.decryptChunk(
        itemId,
        chunkSetId,
        chunkIndex,
        totalChunks,
        ciphertext,
        nonce,
    );
}

export function buildIndexTask(docs: SearchDoc[]): Promise<{ count: number }> {
    return cryptoWorker.buildIndex(docs);
}

export function addIndexDocTask(doc: SearchDoc): Promise<void> {
    return cryptoWorker.addIndexDoc(doc);
}

export function addIndexDocsTask(docs: SearchDoc[]): Promise<void> {
    return cryptoWorker.addIndexDocs(docs);
}

export function removeIndexDocTask(docId: string): Promise<void> {
    return cryptoWorker.removeIndexDoc(docId);
}

export function searchIndexTask(query: string, limit?: number): Promise<SearchHit[]> {
    return cryptoWorker.searchIndex(query, limit);
}

export function serializeIndexTask(): Promise<SerializedIndexBlob> {
    return cryptoWorker.serializeIndex();
}

export function loadPersistedIndexTask(blob: {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    ikCiphertext: Uint8Array;
    ikNonce: Uint8Array;
}): Promise<{ count: number }> {
    return cryptoWorker.loadPersistedIndex(blob);
}

export type WrapItemKeyForShareResult = {
    wrappedItemKey: Uint8Array;
    itemKeyNonce: Uint8Array;
    fragmentKeyB64url: string;
    shareAuthKeyB64?: string;
    kdfSaltB64?: string;
    kdfParams?: import("@zknotes/shared").KdfParams;
};

/**
 * Wraps an Item Key under the Share Key. The fragment key LEAVES the worker (it has to reach the
 * URL) — a deliberate exception.
 */
/** Derives the share auth key inside the worker — the same context as the unwrap (Argon2 + HKDF). */
export function deriveSharePasswordKeysTask(args: {
    password: string;
    kdfSaltB64: string;
    kdfParams?: import("@zknotes/shared").KdfParams;
}): Promise<{ shareAuthKeyB64: string }> {
    return cryptoWorker.sendDeriveSharePasswordKeys(args);
}

export function wrapItemKeyForShareTask(
    shareId: string,
    itemId: string,
    opts?: {
        password?: string;
        fragmentKeyB64url?: string;
        kdfSaltB64?: string;
        kdfParams?: import("@zknotes/shared").KdfParams;
    },
): Promise<WrapItemKeyForShareResult> {
    return cryptoWorker.sendWrapItemKeyForShare(shareId, itemId, opts).then((res) => res);
}

export function unwrapAndDecryptShareTask<T>(args: {
    shareId: string;
    sourceItemId: string;
    wrappedItemKey: Uint8Array;
    itemKeyNonce: Uint8Array;
    encryptedPayload: Uint8Array;
    payloadNonce: Uint8Array;
    fragmentKeyB64url: string;
    password?: string;
    kdfSaltB64?: string;
    kdfParams?: import("@zknotes/shared").KdfParams;
    version?: number;
    retainItemKey?: boolean;
}): Promise<{ data: T; itemKey?: Uint8Array }> {
    return cryptoWorker.sendUnwrapAndDecryptShare<T>(args);
}

export function decryptChunkWithKeyTask(
    itemKey: Uint8Array,
    chunkSetId: string,
    chunkIndex: number,
    totalChunks: number,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
): Promise<Uint8Array> {
    return cryptoWorker.decryptChunkWithKey(
        itemKey,
        chunkSetId,
        chunkIndex,
        totalChunks,
        ciphertext,
        nonce,
    );
}
