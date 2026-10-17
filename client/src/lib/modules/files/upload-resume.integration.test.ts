// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    openUploadSessionMock,
    mintUploadUrlsMock,
    putChunkMock,
    finalizeUploadMock,
    getUploadStatusMock,
    encryptChunkTaskMock,
    encryptPayloadTaskMock,
    generateItemKeyTaskMock,
    createFromUploadMock,
    abortUploadMock,
} = vi.hoisted(() => ({
    openUploadSessionMock: vi.fn(),
    mintUploadUrlsMock: vi.fn(),
    putChunkMock: vi.fn().mockResolvedValue(undefined),
    finalizeUploadMock: vi.fn().mockResolvedValue(undefined),
    getUploadStatusMock: vi.fn(),
    encryptChunkTaskMock: vi.fn(),
    encryptPayloadTaskMock: vi.fn(),
    generateItemKeyTaskMock: vi.fn(),
    createFromUploadMock: vi.fn().mockResolvedValue(undefined),
    abortUploadMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/core/api/files", async (importOriginal) => ({
    ...(await importOriginal<typeof import("$lib/core/api/files")>()),
    abortUpload: abortUploadMock,
}));

vi.mock("$lib/core/api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("$lib/core/api")>()),
    openUploadSession: openUploadSessionMock,
    mintUploadUrls: mintUploadUrlsMock,
    putChunk: putChunkMock,
    finalizeUpload: finalizeUploadMock,
    getUploadStatus: getUploadStatusMock,
    pingUploadSession: vi.fn().mockResolvedValue({ ok: true, session_status: "uploading" }),
}));

vi.mock("$lib/core/workers/crypto-rpc", () => ({
    encryptChunkTask: encryptChunkTaskMock,
    encryptPayloadTask: encryptPayloadTaskMock,
    generateItemKeyTask: generateItemKeyTaskMock,
    addCachedItemKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./limits", () => ({
    getMaxFileSize: vi.fn(() => 50 * 1024 * 1024),
    getMaxFileSizeMB: vi.fn(() => 50),
    refreshFileLimits: vi.fn().mockResolvedValue(undefined),
    isOverFileSizeLimit: vi.fn(async (size: number) => size > 50 * 1024 * 1024),
}));

vi.mock("./thumbnail", () => ({
    generateThumbnail: vi.fn().mockResolvedValue(null),
}));

vi.mock("./file-service", () => ({
    FileService: { createFromUpload: createFromUploadMock },
}));

vi.mock("./upload-errors", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./upload-errors")>();
    return { ...actual, sleep: () => Promise.resolve(), retryBackoffMs: () => 0 };
});

import { getDB, type LocalItem, type PendingUpload } from "$lib/core/db";
import { resumeUpload, startNewUpload } from "./upload";
import { loadUploadChunk } from "./upload-chunk-store";

function pngBytes(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

function pendingRow(overrides: Partial<PendingUpload> = {}): PendingUpload {
    const blob = new File([pngBytes()], "photo.png", { type: "image/png" });
    return {
        local_id: "loc-resume-1",
        phase: "paused",
        blob,
        name: "photo.png",
        mime: "image/png",
        plain_size: blob.size,
        note_id: null,
        parent_id: null,
        created_at: Date.now(),
        last_activity_at: Date.now(),
        chunk_set_id: "cs-resume-1",
        item_id: "file-resume-1",
        encrypted_item_key: "aWsh",
        item_key_nonce: "aWtu",
        chunk_size: 5 * 1024 * 1024,
        total_chunks: 1,
        ciphertext_size: blob.size + 16,
        manifest: {
            0: {
                nonce: "bm9uY2U=",
                hash: "aGFzaA==",
                size: 3,
                local_state: "persisted",
            },
        },
        ...overrides,
    };
}

describe("resumeUpload", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
        await db.clear("upload-chunks");
        await db.clear("items");

        encryptChunkTaskMock.mockResolvedValue({
            ciphertext: new Uint8Array([1, 2, 3]),
            nonce: new Uint8Array([4, 5, 6]),
        });
        generateItemKeyTaskMock.mockResolvedValue({
            encryptedItemKey: [7, 8, 9],
            itemKeyNonce: [10, 11, 12],
        });
        encryptPayloadTaskMock.mockResolvedValue({
            ciphertext: new Uint8Array([13, 14, 15]),
            nonce: new Uint8Array([16, 17, 18]),
        });
        mintUploadUrlsMock.mockResolvedValue([{ index: 0, put_url: "https://example/put/0" }]);
        getUploadStatusMock.mockResolvedValue({
            session_status: "uploading",
            expected_chunks: 1,
            expected_size: 28,
            present_indices: [],
            total_present_size: 0,
        });
    });

    it("re-PUTs persisted chunk from upload-chunks store without re-encryption", async () => {
        const row = pendingRow();
        const db = await getDB();
        await db.put("pending-uploads", row);
        await db.put("upload-chunks", {
            key: "loc-resume-1:0",
            pendingLocalId: "loc-resume-1",
            index: 0,
            ciphertext: new Uint8Array([9, 9, 9]),
            nonce: "bm9uY2U=",
            hash: "aGFzaA==",
            size: 3,
            storedAt: Date.now(),
        });

        await resumeUpload(row);

        expect(encryptChunkTaskMock).not.toHaveBeenCalled();
        expect(putChunkMock).toHaveBeenCalledOnce();
        expect(putChunkMock.mock.calls[0]?.[1]).toEqual(new Uint8Array([9, 9, 9]));
        expect(finalizeUploadMock).toHaveBeenCalledWith("cs-resume-1");
        expect(createFromUploadMock).toHaveBeenCalledOnce();
        expect(await loadUploadChunk("loc-resume-1", 0)).toBeNull();
    });

    it("recovers orphan when session is committed and item missing", async () => {
        getUploadStatusMock.mockResolvedValue({
            session_status: "committed",
            expected_chunks: 1,
            expected_size: 28,
            present_indices: [0],
            total_present_size: 3,
        });

        const row = pendingRow({
            manifest: {
                0: {
                    nonce: "bm9uY2U=",
                    hash: "aGFzaA==",
                    size: 3,
                    local_state: "confirmed",
                },
            },
        });

        const db = await getDB();
        await db.put("pending-uploads", row);

        await resumeUpload(row);

        expect(putChunkMock).not.toHaveBeenCalled();
        expect(finalizeUploadMock).not.toHaveBeenCalled();
        expect(createFromUploadMock).toHaveBeenCalledOnce();
        // The staging outlives the local commit: the row waits in `syncing` for the item's push ack.
        expect((await db.get("pending-uploads", "loc-resume-1"))?.phase).toBe("syncing");
    });

    it("committed session whose objects are gone → a fresh session from the local source, never a commit onto the dead set", async () => {
        // GC swept the finalized blob while the item commit never reached the server.
        getUploadStatusMock.mockResolvedValue({
            session_status: "committed",
            expected_chunks: 1,
            expected_size: 28,
            present_indices: [],
            total_present_size: 0,
        });
        openUploadSessionMock.mockResolvedValue({ chunk_set_id: "cs-fresh" });
        const row = pendingRow({
            manifest: {
                0: { nonce: "bm9uY2U=", hash: "aGFzaA==", size: 3, local_state: "confirmed" },
            },
        });
        const db = await getDB();
        await db.put("pending-uploads", row);

        const item = await resumeUpload(row);

        expect(openUploadSessionMock).toHaveBeenCalledOnce();
        expect(putChunkMock).toHaveBeenCalledOnce();
        expect(finalizeUploadMock).toHaveBeenCalledWith("cs-fresh");
        expect(item.chunk_set_id).toBe("cs-fresh");
        expect(createFromUploadMock).toHaveBeenCalledOnce();
        const after = await db.get("pending-uploads", "loc-resume-1");
        expect(after?.chunk_set_id).toBe("cs-fresh");
        expect(after?.phase).toBe("syncing");
    });

    it("`purged` session (the server flipped it when the blob was swept) → the same restart", async () => {
        getUploadStatusMock.mockResolvedValue({
            session_status: "purged",
            expected_chunks: 1,
            expected_size: 28,
            present_indices: [],
            total_present_size: 0,
        });
        openUploadSessionMock.mockResolvedValue({ chunk_set_id: "cs-fresh-2" });
        const row = pendingRow();
        const db = await getDB();
        await db.put("pending-uploads", row);

        const item = await resumeUpload(row);

        expect(item.chunk_set_id).toBe("cs-fresh-2");
        expect(finalizeUploadMock).toHaveBeenCalledWith("cs-fresh-2");
        expect(createFromUploadMock).toHaveBeenCalledOnce();
    });

    it("skips createFromUpload when item already exists (idempotent orphan recovery)", async () => {
        getUploadStatusMock.mockResolvedValue({
            session_status: "committed",
            expected_chunks: 1,
            expected_size: 28,
            present_indices: [0],
            total_present_size: 3,
        });

        const row = pendingRow();
        const db = await getDB();
        await db.put("items", {
            id: "file-resume-1",
            type: "file",
            parent_id: null,
            encrypted_payload: "enc",
            payload_nonce: "nonce",
            encrypted_item_key: "ik",
            item_key_nonce: "ikn",
            chunk_set_id: "cs-resume-1",
            chunk_count: 1,
            ciphertext_size: 28,
            sort_order: "file-resume-1",
            version: 1,
        });

        const item = await resumeUpload(row);

        expect(item.id).toBe("file-resume-1");
        expect(createFromUploadMock).not.toHaveBeenCalled();
    });
});

// An upload whose owner note is in the Trash waits for it — even on the Retry button, which calls
// resumeUpload without the resume predicate in front of it.
describe("resumeUpload — the owner note", () => {
    function ownerNote(extra: Partial<LocalItem> = {}): LocalItem {
        return {
            id: "note-owner",
            type: "note",
            parent_id: null,
            encrypted_payload: "e",
            payload_nonce: "n",
            encrypted_item_key: "k",
            item_key_nonce: "kn",
            sort_order: "a",
            version: 1,
            ...extra,
        } as LocalItem;
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
        await db.clear("items");
        getUploadStatusMock.mockResolvedValue({
            session_status: "purged",
            expected_chunks: 1,
            expected_size: 28,
            present_indices: [],
            total_present_size: 0,
        });
    });

    it("an orphan_committed row whose note is in the Trash asks the server nothing and stays", async () => {
        const db = await getDB();
        await db.put("items", ownerNote({ deleted_at: 100 }));
        const row = pendingRow({ phase: "orphan_committed", parent_id: "note-owner" });
        await db.put("pending-uploads", row);

        await expect(resumeUpload(row)).rejects.toThrow("Owner note is in the Trash");

        expect(getUploadStatusMock).not.toHaveBeenCalled();
        expect((await db.get("pending-uploads", row.local_id))?.phase).toBe("orphan_committed");
    });

    it("an orphan_committed row whose note is gone for good is released, still without a server call", async () => {
        const db = await getDB();
        const row = pendingRow({ phase: "orphan_committed", parent_id: "note-owner" });
        await db.put("pending-uploads", row);

        await expect(resumeUpload(row)).rejects.toThrow("Owner note was deleted");

        expect(getUploadStatusMock).not.toHaveBeenCalled();
        expect(await db.get("pending-uploads", row.local_id)).toBeUndefined();
    });

    it("a swept set does not upload again while the note is in the Trash", async () => {
        const db = await getDB();
        await db.put("items", ownerNote({ deleted_at: 100 }));
        const row = pendingRow({ phase: "paused", parent_id: "note-owner" });
        await db.put("pending-uploads", row);

        await expect(resumeUpload(row)).rejects.toThrow("Owner note is in the Trash");

        expect(openUploadSessionMock).not.toHaveBeenCalled();
        expect((await db.get("pending-uploads", row.local_id))?.phase).toBe("orphan_committed");
    });

    it("a swept set with the note in place uploads again under the same item id", async () => {
        const db = await getDB();
        await db.put("items", ownerNote());
        openUploadSessionMock.mockResolvedValue({ chunk_set_id: "cs-again" });
        mintUploadUrlsMock.mockResolvedValue([{ index: 0, put_url: "https://example/put/0" }]);
        encryptChunkTaskMock.mockResolvedValue({
            ciphertext: new Uint8Array([1, 2, 3]),
            nonce: new Uint8Array([4, 5, 6]),
        });
        generateItemKeyTaskMock.mockResolvedValue({
            encryptedItemKey: [7, 8, 9],
            itemKeyNonce: [10, 11, 12],
        });
        encryptPayloadTaskMock.mockResolvedValue({
            ciphertext: new Uint8Array([13, 14, 15]),
            nonce: new Uint8Array([16, 17, 18]),
        });
        const row = pendingRow({ phase: "paused", parent_id: "note-owner" });
        await db.put("pending-uploads", row);

        const item = await resumeUpload(row);

        expect(item.id).toBe("file-resume-1");
        expect(item.chunk_set_id).toBe("cs-again");
    });
});

describe("a Retry that starts over leaves the dead session behind", () => {
    // The row a dead session S1 left: `failed_expired`, its manifest and one staged S1 chunk. S1
    // ciphertext is bound to S1 (its chunk set id in the AAD, its own Item Key) and is worth nothing
    // in any other session.
    const S1_BYTES = new Uint8Array([9, 9, 9]);

    async function seedDeadSession(): Promise<PendingUpload> {
        const row = pendingRow({ phase: "failed_expired", chunk_set_id: "cs-dead" });
        const db = await getDB();
        await db.put("pending-uploads", row);
        await db.put("upload-chunks", {
            key: "loc-resume-1:0",
            pendingLocalId: "loc-resume-1",
            index: 0,
            ciphertext: S1_BYTES,
            nonce: "bm9uY2U=",
            hash: "aGFzaA==",
            size: 3,
            storedAt: Date.now(),
        });
        return row;
    }

    function sourceOf(row: PendingUpload) {
        return {
            kind: "file" as const,
            name: row.name,
            mime: row.mime,
            size: row.plain_size ?? 0,
            file: row.blob as File,
        };
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
        await db.clear("upload-chunks");
        await db.clear("items");
        encryptChunkTaskMock.mockResolvedValue({
            ciphertext: new Uint8Array([1, 2, 3]),
            nonce: new Uint8Array([4, 5, 6]),
        });
        generateItemKeyTaskMock.mockResolvedValue({
            encryptedItemKey: [7, 8, 9],
            itemKeyNonce: [10, 11, 12],
        });
        encryptPayloadTaskMock.mockResolvedValue({
            ciphertext: new Uint8Array([13, 14, 15]),
            nonce: new Uint8Array([16, 17, 18]),
        });
        mintUploadUrlsMock.mockResolvedValue([{ index: 0, put_url: "https://example/put/0" }]);
    });

    it("the new session opens with no manifest and no staged chunk of the old one", async () => {
        const row = await seedDeadSession();
        let atOpen: { row: PendingUpload | undefined; chunk: unknown } | undefined;
        openUploadSessionMock.mockImplementation(async () => {
            const db = await getDB();
            atOpen = {
                row: await db.get("pending-uploads", "loc-resume-1"),
                chunk: await loadUploadChunk("loc-resume-1", 0),
            };
            return { chunk_set_id: "cs-new" };
        });

        await startNewUpload(sourceOf(row), null, {
            pendingLocalId: "loc-resume-1",
            itemId: "file-resume-1",
        });

        expect(atOpen?.row?.manifest ?? {}).toEqual({});
        expect(atOpen?.row?.chunk_set_id).toBeUndefined();
        expect(atOpen?.chunk).toBeNull();
        expect(putChunkMock.mock.calls[0]?.[1]).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("a restart interrupted after its session opened resumes with fresh ciphertext, never the old session's", async () => {
        const row = await seedDeadSession();
        const ac = new AbortController();
        openUploadSessionMock.mockImplementation(async () => {
            ac.abort();
            return { chunk_set_id: "cs-new" };
        });

        await expect(
            startNewUpload(sourceOf(row), null, {
                pendingLocalId: "loc-resume-1",
                itemId: "file-resume-1",
                signal: ac.signal,
            }),
        ).rejects.toThrow();

        const db = await getDB();
        const interrupted = await db.get("pending-uploads", "loc-resume-1");
        expect(interrupted?.chunk_set_id).toBe("cs-new");
        getUploadStatusMock.mockResolvedValue({
            session_status: "uploading",
            expected_chunks: 1,
            expected_size: 28,
            present_indices: [],
            total_present_size: 0,
        });
        encryptChunkTaskMock.mockClear();

        await resumeUpload(interrupted as PendingUpload);

        expect(encryptChunkTaskMock).toHaveBeenCalledOnce();
        expect(encryptChunkTaskMock.mock.calls[0]?.[1]).toBe("cs-new");
        for (const call of putChunkMock.mock.calls) {
            expect(call[1]).not.toEqual(S1_BYTES);
        }
        expect(finalizeUploadMock).toHaveBeenCalledWith("cs-new");
    });
});

describe("a restore upload that fails gives its session back", () => {
    const source = () => {
        const file = new File([pngBytes()], "photo.png", { type: "image/png" });
        return { kind: "file" as const, name: file.name, mime: file.type, size: file.size, file };
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
        await db.clear("upload-chunks");
        await db.clear("items");
        generateItemKeyTaskMock.mockResolvedValue({
            encryptedItemKey: [7, 8, 9],
            itemKeyNonce: [10, 11, 12],
        });
        mintUploadUrlsMock.mockResolvedValue([{ index: 0, put_url: "https://example/put/0" }]);
        encryptChunkTaskMock.mockRejectedValue(new Error("worker gone"));
    });

    it("aborts the restore_staging session, so it holds no quota and no slot of the restore", async () => {
        openUploadSessionMock.mockResolvedValue({ chunk_set_id: "cs-restore" });

        await expect(
            startNewUpload(source(), null, {
                itemId: "file-r",
                restoreSessionId: "rs-1",
                stageOnly: true,
            }),
        ).rejects.toThrow("worker gone");

        expect(abortUploadMock).toHaveBeenCalledWith("cs-restore");
    });

    it("leaves an ordinary upload's session alone — its pending row resumes it", async () => {
        openUploadSessionMock.mockResolvedValue({ chunk_set_id: "cs-editor" });
        const db = await getDB();
        await db.put(
            "pending-uploads",
            pendingRow({ phase: "opening_session", chunk_set_id: undefined }),
        );

        await expect(
            startNewUpload(source(), null, {
                itemId: "file-resume-1",
                pendingLocalId: "loc-resume-1",
            }),
        ).rejects.toThrow("worker gone");

        expect(abortUploadMock).not.toHaveBeenCalled();
    });
});
