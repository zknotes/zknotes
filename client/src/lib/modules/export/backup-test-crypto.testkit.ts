// An in-process crypto stand-in for the SharedWorker in the backup round-trip tests.
// It uses the @zknotes/shared primitives with a fixed vault key — the same API surface as the
// crypto-rpc tasks that item-codec / upload / import call.

import {
    buildChunkAad,
    buildItemKeyAad,
    buildPayloadAad,
    decryptChunk,
    decryptItemKey,
    decryptPayload,
    encryptChunk,
    encryptItemKey,
    encryptPayload,
    generateItemKey,
} from "@zknotes/shared";

export interface InProcessCryptoState {
    vaultKey: Uint8Array;
    itemKeys: Map<string, Uint8Array>;
    resetKeys: () => void;
}

/**
 * An object suitable for `vi.mock("$lib/core/workers/crypto-rpc", () => …)`.
 * The state has to come from `vi.hoisted`, so the mock factory sees the same Map across the tests.
 */
export function createCryptoRpcMock(state: InProcessCryptoState) {
    return {
        unlockWorker: async () => {},
        logoutWorker: async () => {
            state.resetKeys();
        },
        addCachedItemKey: async (
            itemId: string,
            encryptedItemKey: Uint8Array,
            itemKeyNonce: Uint8Array,
        ) => {
            const ik = decryptItemKey(
                encryptedItemKey,
                itemKeyNonce,
                state.vaultKey,
                buildItemKeyAad(itemId),
            );
            state.itemKeys.set(itemId, ik);
        },
        encryptPayloadTask: async (itemId: string, data: unknown, version: number) => {
            const ik = state.itemKeys.get(itemId);
            if (!ik) throw new Error(`Item key not found for ${itemId}`);
            const { ciphertext, nonce } = encryptPayload(
                data as object,
                ik,
                buildPayloadAad(itemId, version),
            );
            return { ciphertext, nonce };
        },
        encryptPayloadWithNewKeyTask: async (itemId: string, data: unknown, version: number) => {
            const ik = generateItemKey();
            state.itemKeys.set(itemId, ik);
            const { ciphertext, nonce } = encryptPayload(
                data as object,
                ik,
                buildPayloadAad(itemId, version),
            );
            const wrapped = encryptItemKey(ik, state.vaultKey, buildItemKeyAad(itemId));
            return {
                encryptedItemKey: wrapped.ciphertext,
                itemKeyNonce: wrapped.nonce,
                ciphertext,
                nonce,
            };
        },
        decryptPayloadTask: async <T>(
            itemId: string,
            ciphertext: Uint8Array,
            nonce: Uint8Array,
            version: number,
        ): Promise<T> => {
            const ik = state.itemKeys.get(itemId);
            if (!ik) throw new Error(`Item key not found for ${itemId}`);
            return decryptPayload<T>(ciphertext, nonce, ik, buildPayloadAad(itemId, version));
        },
        decryptPayloadWithKeyTask: async <T>(
            itemId: string,
            encryptedItemKey: Uint8Array,
            itemKeyNonce: Uint8Array,
            ciphertext: Uint8Array,
            nonce: Uint8Array,
            version: number,
        ): Promise<T> => {
            const ik = decryptItemKey(
                encryptedItemKey,
                itemKeyNonce,
                state.vaultKey,
                buildItemKeyAad(itemId),
            );
            state.itemKeys.set(itemId, ik);
            return decryptPayload<T>(ciphertext, nonce, ik, buildPayloadAad(itemId, version));
        },
        generateItemKeyTask: async (itemId: string) => {
            const ik = generateItemKey();
            state.itemKeys.set(itemId, ik);
            const wrapped = encryptItemKey(ik, state.vaultKey, buildItemKeyAad(itemId));
            return {
                encryptedItemKey: Array.from(wrapped.ciphertext),
                itemKeyNonce: Array.from(wrapped.nonce),
            };
        },
        encryptChunkTask: async (
            itemId: string,
            chunkSetId: string,
            chunkIndex: number,
            totalChunks: number,
            plaintext: Uint8Array,
        ) => {
            const ik = state.itemKeys.get(itemId);
            if (!ik) throw new Error(`Item key not found for ${itemId}`);
            return encryptChunk(plaintext, ik, buildChunkAad(chunkSetId, chunkIndex, totalChunks));
        },
        decryptChunkTask: async (
            itemId: string,
            chunkSetId: string,
            chunkIndex: number,
            totalChunks: number,
            ciphertext: Uint8Array,
            nonce: Uint8Array,
        ) => {
            const ik = state.itemKeys.get(itemId);
            if (!ik) throw new Error(`Item key not found for ${itemId}`);
            return decryptChunk(
                ciphertext,
                nonce,
                ik,
                buildChunkAad(chunkSetId, chunkIndex, totalChunks),
            );
        },
    };
}
