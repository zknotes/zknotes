import { strFromU8, strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { BackupEncryptor, decryptBackup, isEncryptedBackup } from "./backup-crypto";
import { createMemorySink, encryptedSink, ZipStreamWriter } from "./sink";

function memorySink() {
    return createMemorySink();
}

describe("ZipStreamWriter", () => {
    it("builds a valid ZIP that unzipSync reads back", async () => {
        const { sink, bytes } = memorySink();
        const zw = new ZipStreamWriter(sink);
        await zw.addFile("manifest.json", strToU8('{"v":1}'), true);
        await zw.addFile("files/a.bin", new Uint8Array([1, 2, 3, 4]), false);
        await zw.finish();

        const entries = unzipSync(bytes());
        expect(strFromU8(entries["manifest.json"]!)).toBe('{"v":1}');
        expect(Array.from(entries["files/a.bin"]!)).toEqual([1, 2, 3, 4]);
    });
});

describe("encryptedSink + ZipStreamWriter", () => {
    it("an encrypted ZIP decrypts and unpacks again", async () => {
        const { sink, bytes } = memorySink();
        const enc = await BackupEncryptor.create("pw-123", 64);
        const wrapped = encryptedSink(sink, enc);
        const zw = new ZipStreamWriter(wrapped);
        await zw.addFile("items.json", strToU8('[{"id":"x"}]'), true);
        await zw.addFile("files/big", new Uint8Array(200).fill(9), false);
        await zw.finish();
        await wrapped.close(); // the orchestrator closes the sink → it emits the final frame

        const container = bytes();
        expect(isEncryptedBackup(container)).toBe(true);

        const zipBytes = await decryptBackup(container, "pw-123");
        const entries = unzipSync(zipBytes);
        expect(strFromU8(entries["items.json"]!)).toBe('[{"id":"x"}]');
        expect(entries["files/big"]!.length).toBe(200);
    });
});
