import { describe, expect, it, vi } from "vitest";
import { fromBase64, toBase64 } from "$lib/core/utils/base64";
import {
    decryptItemPayload,
    decryptManyItemPayloads,
    encryptItemPayloadToBase64,
} from "./item-codec";

// Mock the crypto-rpc worker RPC calls
vi.mock("$lib/core/workers/crypto-rpc", () => {
    return {
        addCachedItemKey: vi.fn().mockResolvedValue(undefined),
        decryptPayloadTask: vi.fn().mockImplementation(async (_id, encrypted, _nonce, _version) => {
            // A simple mock: assume the encrypted bytes are the JSON-stringified payload
            const str = new TextDecoder().decode(encrypted);
            if (str === "FAIL") throw new Error("Decryption failed");
            return JSON.parse(str);
        }),
        decryptPayloadWithKeyTask: vi
            .fn()
            .mockImplementation(async (_id, _key, _keyNonce, encrypted, _nonce, _version) => {
                // Same mock semantics as decryptPayloadTask above — decryptItemPayload now uses the
                // combined op, one round trip instead of two.
                const str = new TextDecoder().decode(encrypted);
                if (str === "FAIL") throw new Error("Decryption failed");
                return JSON.parse(str);
            }),
        encryptPayloadTask: vi.fn().mockImplementation(async (_id, payload, _version) => {
            // A simple mock: return the JSON-stringified payload as bytes
            const str = JSON.stringify(payload);
            const ciphertext = new TextEncoder().encode(str).buffer;
            const nonce = new Uint8Array([1, 2, 3]).buffer;
            return { ciphertext, nonce };
        }),
        decryptManyPayloadsTask: vi.fn().mockImplementation(async (items) => {
            return items.map((it: { itemId: string; ciphertext: Uint8Array }) => {
                const str = new TextDecoder().decode(it.ciphertext);
                if (str === "FAIL") return { itemId: it.itemId, error: "Decryption failed" };
                return { itemId: it.itemId, data: JSON.parse(str) };
            });
        }),
    };
});

describe("item-codec", () => {
    it("should decrypt a valid item payload", async () => {
        const payloadObj = { title: "Test Note" };
        const encryptedBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
        const nonceBytes = new Uint8Array([1, 2, 3]);

        const item = {
            id: "note-123",
            encrypted_payload: toBase64(encryptedBytes),
            payload_nonce: toBase64(nonceBytes),
            encrypted_item_key: toBase64(new Uint8Array([4, 5, 6])),
            item_key_nonce: toBase64(new Uint8Array([7, 8, 9])),
        };

        const result = await decryptItemPayload<any>(item);
        expect(result).toEqual(payloadObj);
    });

    it("should encrypt an item payload to base64 properly", async () => {
        const payloadObj = { title: "New Title" };
        const id = "note-456";

        const result = await encryptItemPayloadToBase64(id, 1, payloadObj);

        expect(result.encrypted_payload).toBeTypeOf("string");
        expect(result.payload_nonce).toBeTypeOf("string");

        // Check that the mock's structure is what we expect
        const decryptedStr = new TextDecoder().decode(fromBase64(result.encrypted_payload));
        expect(JSON.parse(decryptedStr)).toEqual(payloadObj);
    });

    it("should throw if decryption fails", async () => {
        const item = {
            id: "note-err",
            encrypted_payload: toBase64(new TextEncoder().encode("FAIL")),
            payload_nonce: toBase64(new Uint8Array([1, 2])),
            encrypted_item_key: toBase64(new Uint8Array([3])),
            item_key_nonce: toBase64(new Uint8Array([4])),
        };

        await expect(decryptItemPayload(item)).rejects.toThrow("Decryption failed");
    });

    // A regression: decryptManyItemPayloads sends the WHOLE batch in ONE
    // worker round trip instead of ADD_ITEM_KEY+DECRYPT_PAYLOAD per item (2× N round trips).
    it("decryptManyItemPayloads decrypts a batch and isolates per-item failures", async () => {
        const ok1 = { title: "Note A" };
        const ok2 = { title: "Note B" };
        const items = [
            {
                id: "note-a",
                version: 1,
                encrypted_payload: toBase64(new TextEncoder().encode(JSON.stringify(ok1))),
                payload_nonce: toBase64(new Uint8Array([1])),
                encrypted_item_key: toBase64(new Uint8Array([1])),
                item_key_nonce: toBase64(new Uint8Array([1])),
            },
            {
                id: "note-bad",
                version: 1,
                encrypted_payload: toBase64(new TextEncoder().encode("FAIL")),
                payload_nonce: toBase64(new Uint8Array([2])),
                encrypted_item_key: toBase64(new Uint8Array([2])),
                item_key_nonce: toBase64(new Uint8Array([2])),
            },
            {
                id: "note-b",
                version: 1,
                encrypted_payload: toBase64(new TextEncoder().encode(JSON.stringify(ok2))),
                payload_nonce: toBase64(new Uint8Array([3])),
                encrypted_item_key: toBase64(new Uint8Array([3])),
                item_key_nonce: toBase64(new Uint8Array([3])),
            },
        ];

        const results = await decryptManyItemPayloads<typeof ok1>(items);

        expect(results).toHaveLength(3);
        expect(results[0]).toEqual({ id: "note-a", data: ok1, error: undefined });
        expect(results[1]?.id).toBe("note-bad");
        expect(results[1]?.error).toBeInstanceOf(Error);
        expect(results[1]?.data).toBeUndefined();
        expect(results[2]).toEqual({ id: "note-b", data: ok2, error: undefined });
    });

    it("decryptManyItemPayloads returns empty array for empty input without a worker call", async () => {
        const results = await decryptManyItemPayloads([]);
        expect(results).toEqual([]);
    });
});
