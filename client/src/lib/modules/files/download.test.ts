import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    decryptItemPayloadMock,
    loadChunkMock,
    decryptChunkTaskMock,
    hasAllChunksMock,
    shouldAutoDownloadMock,
} = vi.hoisted(() => ({
    decryptItemPayloadMock: vi.fn(),
    loadChunkMock: vi.fn(),
    decryptChunkTaskMock: vi.fn(),
    hasAllChunksMock: vi.fn(),
    shouldAutoDownloadMock: vi.fn(),
}));

vi.mock("$lib/core/crypto/item-codec", () => ({
    decryptItemPayload: decryptItemPayloadMock,
}));

vi.mock("$lib/core/files/chunk-loader", () => ({
    loadChunk: loadChunkMock,
}));

vi.mock("$lib/core/workers/crypto-rpc", () => ({
    decryptChunkTask: decryptChunkTaskMock,
}));

vi.mock("$lib/core/db/file-chunks", () => ({
    hasAllChunks: hasAllChunksMock,
}));

vi.mock("./sync-settings", () => ({
    shouldAutoDownload: shouldAutoDownloadMock,
}));

vi.mock("./files-changed-bus", () => ({
    emitFilesChanged: vi.fn(),
}));

import { getDB, type LocalItem } from "$lib/core/db";
import {
    decryptFile,
    FileDeletedError,
    FileNotLocalError,
    peekSniffFile,
    saveFile,
} from "./download";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function filePayload() {
    return {
        kind: "file" as const,
        chunkSetId: "cs-1",
        name: "photo.png",
        mime: "image/png",
        size: PNG.byteLength,
        chunkSize: 5 * 1024 * 1024,
        chunks: [{ nonce: "bm9uY2U=", hash: "aGFzaA==", size: 32 }],
    };
}

async function seedFile(id: string, overrides: Partial<LocalItem> = {}): Promise<void> {
    const db = await getDB();
    await db.put("items", {
        id,
        type: "file",
        parent_id: null,
        encrypted_payload: "enc",
        payload_nonce: "nonce",
        encrypted_item_key: "ik",
        item_key_nonce: "ikn",
        chunk_set_id: "cs-1",
        chunk_count: 1,
        ciphertext_size: 48,
        sort_order: id,
        version: 1,
        dirty: false,
        localRev: 0,
        ...overrides,
    } as LocalItem);
}

describe("download", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("items");
        decryptItemPayloadMock.mockResolvedValue(filePayload());
        loadChunkMock.mockResolvedValue(new Uint8Array([9, 9, 9]));
        decryptChunkTaskMock.mockResolvedValue(PNG);
        hasAllChunksMock.mockResolvedValue(true);
        shouldAutoDownloadMock.mockReturnValue(true);
    });

    it("throws FileDeletedError when item is in trash", async () => {
        await seedFile("file-trashed", { deleted_at: 1_700_000_000 });

        await expect(decryptFile("file-trashed")).rejects.toMatchObject({
            name: "FileDeletedError",
            reason: "trashed",
        });
        expect(decryptItemPayloadMock).not.toHaveBeenCalled();
    });

    it("throws FileDeletedError when item row is missing", async () => {
        await expect(decryptFile("missing-file")).rejects.toMatchObject({
            name: "FileDeletedError",
            reason: "gone",
        });
    });

    it("throws FileNotLocalError when chunks are remote and auto-download is blocked", async () => {
        await seedFile("file-remote");
        hasAllChunksMock.mockResolvedValue(false);
        shouldAutoDownloadMock.mockReturnValue(false);

        await expect(decryptFile("file-remote")).rejects.toBeInstanceOf(FileNotLocalError);
        expect(loadChunkMock).not.toHaveBeenCalled();
    });

    it("decryptFile sniffs raster render from plaintext bytes", async () => {
        await seedFile("file-ready");

        const result = await decryptFile("file-ready");

        expect(result.render).toBe("raster");
        expect(result.blobMime).toBe("image/png");
        expect(result.name).toBe("photo.png");
        expect(decryptChunkTaskMock).toHaveBeenCalledOnce();
    });

    it("SVG stays download-only preview with original bytes (not remapped to raster)", async () => {
        const svg = new TextEncoder().encode(
            '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000"></svg>',
        );
        decryptItemPayloadMock.mockResolvedValue({
            ...filePayload(),
            name: "icon.svg",
            mime: "image/svg+xml",
            size: svg.byteLength,
        });
        decryptChunkTaskMock.mockResolvedValue(svg);
        await seedFile("file-svg");

        const result = await decryptFile("file-svg");

        expect(result.render).toBe("download");
        expect(result.name).toBe("icon.svg");
        expect(result.bytes).toEqual(svg);
    });

    it("peekSniffFile decrypts only first chunk for sniff decision", async () => {
        await seedFile("file-peek");

        const sniff = await peekSniffFile("file-peek");

        expect(sniff.render).toBe("raster");
        expect(decryptChunkTaskMock).toHaveBeenCalledOnce();
        expect(decryptChunkTaskMock.mock.calls[0]?.[2]).toBe(0);
    });

    // A regression: an earlier change implemented "an export must not fill the chunk cache"
    // (persist:false for the backup ONLY) as "persist only when pinned" — which broke ordinary
    // viewing of UNpinned files (99% of cases): view once → reload offline → "could not load file"
    // (caught by the 18-file-offline-read.spec.ts E2E). The pin-aware EVICTION (chunk-loader's
    // enforceCap) stays correct — the problem was entirely in this caller.
    it("persists chunks to the offline cache by default, even for an unpinned file (view-once must survive reload)", async () => {
        await seedFile("file-view-once");

        await decryptFile("file-view-once");

        expect(loadChunkMock).toHaveBeenCalledOnce();
        const opts = loadChunkMock.mock.calls[0]?.[4];
        expect(opts?.persist).not.toBe(false);
    });

    it("skips persistence only when the caller explicitly opts out (export/backup one-shot read)", async () => {
        await seedFile("file-export");

        await decryptFile("file-export", undefined, { persist: false });

        const opts = loadChunkMock.mock.calls[0]?.[4];
        expect(opts?.persist).toBe(false);
    });

    it("forceDownload bypasses local policy guard", async () => {
        await seedFile("file-force");
        hasAllChunksMock.mockResolvedValue(false);
        shouldAutoDownloadMock.mockReturnValue(false);

        const result = await decryptFile("file-force", undefined, { forceDownload: true });

        expect(result.render).toBe("raster");
        expect(loadChunkMock).toHaveBeenCalledOnce();
    });

    it("saveFile streams chunks without assembling full decryptFile (user-initiated)", async () => {
        await seedFile("file-save");
        hasAllChunksMock.mockResolvedValue(false);
        shouldAutoDownloadMock.mockReturnValue(false);

        // No showSaveFilePicker and no OPFS in the unit environment → a memory blob sink.
        const createObjectURL = vi.fn(() => "blob:dl");
        const revokeObjectURL = vi.fn();
        vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
        const click = vi.fn();
        const anchor = { href: "", download: "", click, remove: vi.fn() };
        vi.stubGlobal("document", {
            createElement: vi.fn(() => anchor),
            body: { appendChild: vi.fn() },
        });

        await saveFile("file-save");

        // It has to work even when the auto-download policy blocks decryptFile (the force path).
        expect(loadChunkMock).toHaveBeenCalledOnce();
        expect(decryptChunkTaskMock).toHaveBeenCalledOnce();
        expect(click).toHaveBeenCalledOnce();
        expect(createObjectURL).toHaveBeenCalledOnce();
    });
});
