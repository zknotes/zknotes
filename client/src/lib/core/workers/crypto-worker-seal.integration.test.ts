/**
 * The seal messages of the real crypto worker: the content hash computed while decrypting, and the
 * seal record's own key and AAD.
 */
import { createHash } from "node:crypto";
import {
    buildChunkAad,
    buildItemKeyAad,
    encryptChunk,
    encryptItemKey,
    generateItemKey,
} from "@zknotes/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CryptoWorkerClient, SealCiphertext } from "./crypto-rpc";

let worker: CryptoWorkerClient;
const vaultKey = new Uint8Array(32).fill(3);

beforeAll(async () => {
    const rpc = await import("./crypto-rpc");
    const { loadInProcessCryptoWorker } = await import("./crypto-worker.testkit");
    worker = new rpc.CryptoWorkerClient(await loadInProcessCryptoWorker());
});

beforeEach(async () => {
    await worker.logout();
    await worker.unlock(vaultKey.slice());
});

describe("seal content hash", () => {
    it("AC1: 100 MiB in 5 MiB chunks hashes to the plaintext's SHA-256, chunk by chunk", async () => {
        const itemId = "0192f0d0-0000-7000-8000-000000000001";
        const chunkSetId = "0192f0d0-0000-7000-8000-000000000002";
        const ik = generateItemKey();
        const wrapped = encryptItemKey(ik, vaultKey, buildItemKeyAad(itemId));
        await worker.addCachedItemKey(itemId, wrapped.ciphertext, wrapped.nonce);

        const total = 20;
        const chunk = new Uint8Array(5 * 1024 * 1024);
        const reference = createHash("sha256");
        await worker.sealHashStart("s1");
        for (let i = 0; i < total; i++) {
            chunk.fill(i * 7);
            reference.update(chunk);
            const enc = encryptChunk(chunk, ik, buildChunkAad(chunkSetId, i, total));
            await worker.sealHashChunk({
                sessionId: "s1",
                itemId,
                chunkSetId,
                chunkIndex: i,
                totalChunks: total,
                ciphertext: enc.ciphertext,
                nonce: enc.nonce,
            });
        }
        expect(await worker.sealHashFinish("s1")).toEqual({
            sha256Hex: reference.digest("hex"),
            byteLength: total * chunk.length,
        });
    }, 180_000);

    it("a chunk under the wrong position fails, and LOGOUT ends every session", async () => {
        const itemId = "0192f0d0-0000-7000-8000-000000000003";
        const ik = generateItemKey();
        const wrapped = encryptItemKey(ik, vaultKey, buildItemKeyAad(itemId));
        await worker.addCachedItemKey(itemId, wrapped.ciphertext, wrapped.nonce);
        const enc = encryptChunk(new Uint8Array([1, 2, 3]), ik, buildChunkAad("cs", 0, 2));
        await worker.sealHashStart("s2");
        await expect(
            worker.sealHashChunk({
                sessionId: "s2",
                itemId,
                chunkSetId: "cs",
                chunkIndex: 1,
                totalChunks: 2,
                ciphertext: enc.ciphertext,
                nonce: enc.nonce,
            }),
        ).rejects.toThrow();
        await worker.logout();
        await worker.unlock(vaultKey.slice());
        await expect(worker.sealHashFinish("s2")).rejects.toThrow(/Unknown seal hash session/);
    });
});

describe("seal record", () => {
    const sealId = "0192f0d0-0000-7000-8000-00000000000a";
    const record = { v: 1, chunk_set_id: "x", manifest: '{"a":1}', proof: "AAEC" };

    it("round-trips under its own seal id", async () => {
        const c = await worker.sealEncryptRecord(sealId, record);
        expect(c.encryptedSealKey.length).toBe(48);
        expect(await worker.sealDecryptRecord(sealId, c)).toEqual(record);
    });

    it("refuses a record moved to another seal id, and a key from another record", async () => {
        const a = await worker.sealEncryptRecord(sealId, record);
        const otherId = "0192f0d0-0000-7000-8000-00000000000b";
        await expect(worker.sealDecryptRecord(otherId, a)).rejects.toThrow();
        const b = await worker.sealEncryptRecord(otherId, record);
        const mixed: SealCiphertext = {
            ...a,
            encryptedSealKey: b.encryptedSealKey,
            sealKeyNonce: b.sealKeyNonce,
        };
        await expect(worker.sealDecryptRecord(sealId, mixed)).rejects.toThrow();
    });

    it("needs the vault to be unlocked", async () => {
        const c = await worker.sealEncryptRecord(sealId, record);
        await worker.logout();
        await expect(worker.sealDecryptRecord(sealId, c)).rejects.toThrow(/not unlocked/);
    });
});
