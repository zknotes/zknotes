/**
 * A full backup round trip with no UI — a predictable vault (folders, notes, files covering every
 * edge case) → export (ZIP + .cnbackup) → import overwrite → decrypt and assert.
 *
 * Crypto: in-process @zknotes/shared (not the SharedWorker).
 * The upload network: a mock S3 map (putChunk/getChunk).
 */
import "fake-indexeddb/auto";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoState = vi.hoisted(() => {
    // A minimal inline state — backup-test-crypto.testkit is imported after the mock.
    const vaultKey = new Uint8Array(32).fill(0x42);
    const itemKeys = new Map<string, Uint8Array>();
    return {
        vaultKey,
        itemKeys,
        resetKeys: () => itemKeys.clear(),
    };
});

const s3Store = vi.hoisted(() => new Map<string, Uint8Array>());
let chunkSetSeq = 0;

vi.mock("$lib/core/workers/crypto-rpc", async () => {
    const { createCryptoRpcMock } = await import("./backup-test-crypto.testkit");
    return createCryptoRpcMock(cryptoState);
});

vi.mock("$lib/core/api", () => ({
    openUploadSession: vi.fn(async () => {
        chunkSetSeq += 1;
        return { chunk_set_id: `upload-cs-${chunkSetSeq}` };
    }),
    mintUploadUrls: vi.fn(async (chunkSetId: string, indices: number[]) =>
        indices.map((index) => ({
            index,
            put_url: `https://s3.test/${chunkSetId}/${index}`,
        })),
    ),
    putChunk: vi.fn(async (putUrl: string, ciphertext: Uint8Array) => {
        s3Store.set(putUrl, ciphertext.slice());
    }),
    finalizeUpload: vi.fn(async () => undefined),
    abortUpload: vi.fn(async () => undefined),
    getUploadStatus: vi.fn(async () => ({
        session_status: "uploading",
        present_indices: [] as number[],
    })),
    pingUploadSession: vi.fn(async () => ({ ok: true, session_status: "uploading" })),
    getChunk: vi.fn(async (chunkSetId: string, index: number) => {
        const url = `https://s3.test/${chunkSetId}/${index}`;
        const ct = s3Store.get(url);
        if (!ct) throw new Error(`chunk miss ${chunkSetId}:${index}`);
        return ct.slice();
    }),
    pushBatch: vi.fn(async () => ({ succeeded: [], conflicts: [], errors: [] })),
    openUpload: vi.fn(),
}));

vi.mock("$lib/core/api/files", () => ({
    abortUpload: vi.fn(async () => undefined),
}));

vi.mock("$lib/core/search", () => ({
    addOrUpdateDoc: vi.fn().mockResolvedValue(undefined),
    removeDoc: vi.fn().mockResolvedValue(undefined),
    flushIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/core/sync", async (importOriginal) => {
    const actual = await importOriginal<typeof import("$lib/core/sync")>();
    return {
        ...actual,
        pullAndMerge: vi.fn().mockResolvedValue({ itemCount: 0, changedIds: [] }),
        pushItem: vi.fn().mockResolvedValue(undefined),
        pushPendingMutations: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock("$lib/modules/files/limits", () => ({
    getMaxFileSize: vi.fn(() => 50 * 1024 * 1024),
    getMaxFileSizeMB: vi.fn(() => 50),
    refreshFileLimits: vi.fn().mockResolvedValue(undefined),
    isOverFileSizeLimit: vi.fn(async (size: number) => size > 50 * 1024 * 1024),
}));

vi.mock("$lib/modules/files/thumbnail", () => ({
    generateThumbnail: vi.fn().mockResolvedValue(null),
}));

vi.mock("$lib/modules/files/sync-settings", () => ({
    shouldAutoDownload: vi.fn(() => true),
}));

import { getDB } from "$lib/core/db";
import { shouldAutoDownload } from "$lib/modules/files/sync-settings";
import { isEncryptedBackup } from "./backup-crypto";
import {
    buildFixtureVault,
    FIXTURE_IDS,
    FIXTURE_MULTI_BYTES,
    FIXTURE_NOTE_ATTACHMENT_BYTES,
    FIXTURE_PNG_BYTES,
    FIXTURE_TEXT_BYTES,
    fixtureCounts,
} from "./backup-fixture";
import { clearVaultStores, seedFixtureVault } from "./backup-fixture-seed.testkit";
import type { BackupFile, BackupFolder, BackupNote } from "./full-backup";
import { exportFullBackup } from "./full-backup";
import { parseBackupZip, parseEncryptedBackupZip } from "./full-backup-import";
import { createMemorySink } from "./sink";

const BACKUP_PASS = "fixture-backup-pass-xyz";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

describe("full backup roundtrip (fixture vault)", () => {
    beforeEach(async () => {
        cryptoState.resetKeys();
        s3Store.clear();
        chunkSetSeq = 0;
        await clearVaultStores();
    });

    it("fixture covers folders, notes and files", () => {
        const c = fixtureCounts();
        expect(c.folders).toBe(3);
        expect(c.notes).toBe(6);
        expect(c.files).toBe(5);
        expect(c.total).toBe(14);
        expect(FIXTURE_MULTI_BYTES.byteLength).toBeGreaterThan(12);
        expect(FIXTURE_TEXT_BYTES.byteLength).toBeGreaterThan(0);
        expect(FIXTURE_PNG_BYTES[0]).toBe(0x89);
        expect(FIXTURE_NOTE_ATTACHMENT_BYTES.byteLength).toBeGreaterThan(0);
    });

    it("export → parse ZIP preserves all fixture plaintext", async () => {
        await seedFixtureVault(cryptoState);
        const mem = createMemorySink();
        await exportFullBackup({ includeFiles: true, sink: mem.sink });

        const parsed = parseBackupZip(mem.bytes());
        const vault = buildFixtureVault();

        expect(parsed.items.length).toBe(vault.items.length);
        expect(parsed.fileMap.size).toBe(vault.fileMap.size);

        for (const exp of vault.items) {
            const got = parsed.items.find((i) => i.id === exp.id);
            expect(got, exp.id).toBeTruthy();
            expect(got!.type).toBe(exp.type);
            expect(got!.parent_id).toBe(exp.parent_id);
            if (exp.type === "note") {
                expect((got as BackupNote).title).toBe(exp.title);
                expect((got as BackupNote).content).toBe(exp.content);
                expect((got as BackupNote).starred ?? false).toBe(exp.starred ?? false);
                expect((got as BackupNote).outlineVisible).toBe(exp.outlineVisible);
                // contentTitle has to make it into the backup (omitted when the original has none).
                expect((got as BackupNote).contentTitle).toBe(exp.contentTitle);
            } else if (exp.type === "folder") {
                expect((got as { title: string }).title).toBe(exp.title);
                expect((got as BackupFolder).starred ?? false).toBe(exp.starred ?? false);
            } else {
                expect((got as BackupFile).name).toBe(exp.name);
                expect((got as BackupFile).mime).toBe(exp.mime);
                const bytes = parsed.fileMap.get(exp.id);
                expect(bytes).toBeTruthy();
                expect(bytesEqual(bytes!, vault.fileMap.get(exp.id)!)).toBe(true);
            }
        }

        // A multi-chunk file is reassembled into its full bytes in the export.
        expect(bytesEqual(parsed.fileMap.get(FIXTURE_IDS.fileMulti)!, FIXTURE_MULTI_BYTES)).toBe(
            true,
        );
    });

    it("encrypted .cnbackup export → parse restores fixture plaintext", async () => {
        await seedFixtureVault(cryptoState);
        const mem = createMemorySink();
        await exportFullBackup({
            encrypt: true,
            passphrase: BACKUP_PASS,
            includeFiles: true,
            sink: mem.sink,
        });

        const blob = mem.bytes();
        expect(isEncryptedBackup(blob)).toBe(true);
        const parsed = await parseEncryptedBackupZip(blob, BACKUP_PASS);
        expect(parsed.items.length).toBe(fixtureCounts().total);
        expect(parsed.fileMap.size).toBe(fixtureCounts().files);
    });

    it("wrong passphrase rejects encrypted backup", async () => {
        await seedFixtureVault(cryptoState);
        const mem = createMemorySink();
        await exportFullBackup({
            encrypt: true,
            passphrase: BACKUP_PASS,
            sink: mem.sink,
        });

        await expect(parseEncryptedBackupZip(mem.bytes(), "wrong-pass")).rejects.toThrow();
    });
});

// The device's auto-download policy decides what to cache for viewing, not what a backup
// holds. Under "never" (the mobile default) a file this device never fetched used to be dropped
// while manifest.file_count still counted it. The HTML export's twin is html-export.dom.test.ts
// (its page rewrite needs a DOM).
describe("attachments this device never downloaded", () => {
    beforeEach(async () => {
        cryptoState.resetKeys();
        s3Store.clear();
        chunkSetSeq = 0;
        await clearVaultStores();
        vi.mocked(shouldAutoDownload).mockReturnValue(false);
    });

    afterEach(() => {
        vi.mocked(shouldAutoDownload).mockReturnValue(true);
    });

    /** Moves a file's chunks from this device's cache to the (mock) server. */
    async function evictToServer(fileId: string): Promise<void> {
        const db = await getDB();
        const chunkSetId = `cs-${fileId}`;
        const rows = (await db.getAll("file-chunks")).filter((r) => r.chunkSetId === chunkSetId);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            s3Store.set(
                `https://s3.test/${chunkSetId}/${row.index}`,
                new Uint8Array(row.ciphertext),
            );
            await db.delete("file-chunks", row.key);
        }
    }

    function filesIn(zip: Uint8Array, prefix: string): string[] {
        return Object.keys(unzipSync(zip)).filter((path) => path.startsWith(prefix));
    }

    it("the backup holds a file whose chunks are only on the server, and file_count matches", async () => {
        await seedFixtureVault(cryptoState);
        await evictToServer(FIXTURE_IDS.fileMulti);

        const mem = createMemorySink();
        const result = await exportFullBackup({ includeFiles: true, sink: mem.sink });

        expect(result.skipped).toEqual([]);
        const manifest = JSON.parse(strFromU8(unzipSync(mem.bytes())["manifest.json"]!)) as {
            file_count: number;
        };
        expect(filesIn(mem.bytes(), "files/")).toHaveLength(fixtureCounts().files);
        expect(manifest.file_count).toBe(fixtureCounts().files);
        const restored = parseBackupZip(mem.bytes()).fileMap.get(FIXTURE_IDS.fileMulti);
        expect(bytesEqual(restored!, FIXTURE_MULTI_BYTES)).toBe(true);
    });

    it("a file with a broken chunk is named in skipped and left out of file_count", async () => {
        await seedFixtureVault(cryptoState);
        await evictToServer(FIXTURE_IDS.fileText);
        // The server hands back other bytes than the manifest's hash promises.
        const corrupt = s3Store.get(`https://s3.test/cs-${FIXTURE_IDS.fileText}/0`)!;
        corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const mem = createMemorySink();
        const result = await exportFullBackup({ includeFiles: true, sink: mem.sink });

        expect(result.skipped).toEqual([
            { id: FIXTURE_IDS.fileText, type: "file", reason: expect.any(String) },
        ]);
        const zip = unzipSync(mem.bytes());
        const manifest = JSON.parse(strFromU8(zip["manifest.json"]!)) as { file_count: number };
        expect(zip[`files/${FIXTURE_IDS.fileText}`]).toBeUndefined();
        expect(manifest.file_count).toBe(fixtureCounts().files - 1);
        expect(filesIn(mem.bytes(), "files/")).toHaveLength(manifest.file_count);
    });

    it("the backup leaves no new chunks in the offline cache", async () => {
        await seedFixtureVault(cryptoState);
        await evictToServer(FIXTURE_IDS.fileMulti);
        const db = await getDB();
        const before = await db.count("file-chunks");

        await exportFullBackup({ includeFiles: true, sink: createMemorySink().sink });

        expect(await db.count("file-chunks")).toBe(before);
    });
});
