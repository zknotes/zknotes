import { describe, expect, it } from "vitest";
import { BACKUP_MAGIC, BackupEncryptor, decryptBackup, isEncryptedBackup } from "./backup-crypto";

const PASS = "correct horse battery staple";

// Collect the whole encrypted container out of the streaming encryptor.
async function encryptAll(
    passphrase: string,
    data: Uint8Array,
    chunkSize: number,
): Promise<Uint8Array> {
    const enc = await BackupEncryptor.create(passphrase, chunkSize);
    const parts: Uint8Array[] = [];
    // Push it in small pieces, so we also check the re-chunking is independent of the push boundaries.
    for (let i = 0; i < data.length; i += 7) {
        parts.push(enc.push(data.subarray(i, i + 7)));
    }
    parts.push(enc.finish());
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

const bytes = (n: number): Uint8Array => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
    return b;
};

describe("backup-crypto container", () => {
    it("isEncryptedBackup recognises the magic number and rejects foreign bytes", () => {
        expect(isEncryptedBackup(BACKUP_MAGIC)).toBe(true);
        expect(isEncryptedBackup(new Uint8Array([80, 75, 3, 4]))).toBe(false); // ZIP "PK"
        expect(isEncryptedBackup(new Uint8Array(2))).toBe(false);
    });

    // The framing edge cases: empty, smaller than a chunk, exactly a chunk, several chunks, plus a tail.
    it.each([
        ["empty", 0],
        ["sub-chunk", 10],
        ["exact chunk", 16],
        ["exact multiple", 48],
        ["multi + remainder", 100],
    ])("round-trip %s", async (_label, size) => {
        const data = bytes(size);
        const container = await encryptAll(PASS, data, 16);
        expect(isEncryptedBackup(container)).toBe(true);
        const out = await decryptBackup(container, PASS);
        expect(out).toEqual(data);
    });

    it("a wrong password throws", async () => {
        const container = await encryptAll(PASS, bytes(50), 16);
        await expect(decryptBackup(container, "wrong")).rejects.toThrow(/password|damaged/i);
    });

    it("tampering with the ciphertext throws (a Poly1305 failure)", async () => {
        const container = await encryptAll(PASS, bytes(50), 16);
        // The last byte is in the last frame — definitely part of the ciphertext.
        container[container.length - 1] ^= 0xff;
        await expect(decryptBackup(container, PASS)).rejects.toThrow(/password|damaged/i);
    });

    it("truncation — a removed tail — is detected", async () => {
        const container = await encryptAll(PASS, bytes(100), 16);
        // Drop part of the tail so the last surviving frame is no longer 'final'.
        const truncated = container.subarray(0, container.length - 30);
        await expect(decryptBackup(truncated, PASS)).rejects.toThrow(/damaged|password/i);
    });

    it("decryptBackup refuses non-backup bytes", async () => {
        await expect(decryptBackup(new Uint8Array([1, 2, 3]), PASS)).rejects.toThrow(
            /not a ZKnotes/i,
        );
    });

    it("restore rejects a backup header with excessive KDF cost", async () => {
        const headerObj = {
            v: 1,
            kdf_salt: "c2FsdHNhbHRzYWx0c2FsdA==",
            kdf_params: { m: 524288, t: 1, p: 1 }, // 512 MiB > MAX_KDF_MEMORY_KIB (256 MiB)
            chunk_size: 1024,
        };
        const textEncoder = new TextEncoder();
        const jsonBytes = textEncoder.encode(JSON.stringify(headerObj));
        const lenBuf = new Uint8Array(4);
        new DataView(lenBuf.buffer).setUint32(0, jsonBytes.length, false);

        const container = new Uint8Array(BACKUP_MAGIC.length + 4 + jsonBytes.length);
        container.set(BACKUP_MAGIC, 0);
        container.set(lenBuf, BACKUP_MAGIC.length);
        container.set(jsonBytes, BACKUP_MAGIC.length + 4);

        await expect(decryptBackup(container, PASS)).rejects.toThrow(/too much memory/i);
    });
});
