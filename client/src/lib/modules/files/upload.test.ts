import { FILE_LIMITS } from "@zknotes/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    openUploadSessionMock,
    mintUploadUrlsMock,
    putChunkMock,
    finalizeUploadMock,
    abortUploadMock,
    encryptChunkTaskMock,
    encryptPayloadTaskMock,
    generateItemKeyTaskMock,
    addCachedItemKeyMock,
    createFromUploadMock,
    getDBGetMock,
} = vi.hoisted(() => ({
    openUploadSessionMock: vi.fn(),
    mintUploadUrlsMock: vi.fn(),
    putChunkMock: vi.fn().mockResolvedValue(undefined),
    finalizeUploadMock: vi.fn().mockResolvedValue(undefined),
    abortUploadMock: vi.fn().mockResolvedValue(undefined),
    encryptChunkTaskMock: vi.fn(),
    encryptPayloadTaskMock: vi.fn(),
    generateItemKeyTaskMock: vi.fn(),
    addCachedItemKeyMock: vi.fn().mockResolvedValue(undefined),
    createFromUploadMock: vi.fn().mockResolvedValue(undefined),
    getDBGetMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/core/api", () => ({
    openUploadSession: openUploadSessionMock,
    mintUploadUrls: mintUploadUrlsMock,
    putChunk: putChunkMock,
    finalizeUpload: finalizeUploadMock,
    getUploadStatus: vi.fn(),
    pingUploadSession: vi.fn().mockResolvedValue({ ok: true, session_status: "uploading" }),
    // The real predicate reads `S3PutError.status`/`.code`; the mock keeps the same contract on a
    // plain error so the re-mint tests below can inject a 403 or a checksum-mismatch 400 without
    // the XHR layer.
    isPresignRejected: (err: unknown) => {
        if (!(err instanceof Error)) return false;
        const { status, code } = err as { status?: number; code?: string };
        return (
            status === 403 ||
            code === "AccessDenied" ||
            code === "SignatureDoesNotMatch" ||
            code === "RequestTimeTooSkewed" ||
            code === "BadDigest" ||
            code === "InvalidDigest"
        );
    },
    // Same contract as the real one in files.ts (its truth table is tested in files.test.ts): a 4xx
    // that is not about the signature, the session, the quota or timing.
    isPermanentStorageRejection: (err: unknown) => {
        if (!(err instanceof Error)) return false;
        const { status, code } = err as { status?: number; code?: string };
        return (
            status !== undefined &&
            status >= 400 &&
            status < 500 &&
            ![403, 404, 408, 409, 413, 429].includes(status) &&
            !(
                code !== undefined &&
                [
                    "RequestTimeout",
                    "IncompleteBody",
                    "SlowDown",
                    "RequestTimeTooSkewed",
                    "ExpiredToken",
                ].includes(code)
            )
        );
    },
}));

vi.mock("$lib/core/api/files", () => ({
    abortUpload: abortUploadMock,
}));

vi.mock("$lib/core/db", () => ({
    getDB: vi.fn(async () => ({
        get: getDBGetMock,
        put: vi.fn(),
    })),
}));

vi.mock("$lib/core/workers/crypto-rpc", () => ({
    encryptChunkTask: encryptChunkTaskMock,
    encryptPayloadTask: encryptPayloadTaskMock,
    generateItemKeyTask: generateItemKeyTaskMock,
    addCachedItemKey: addCachedItemKeyMock,
}));

vi.mock("./limits", () => {
    const getMaxFileSize = vi.fn(() => 50 * 1024 * 1024);
    return {
        getMaxFileSize,
        getMaxFileSizeMB: vi.fn(() => 50),
        refreshFileLimits: vi.fn().mockResolvedValue(undefined),
        isOverFileSizeLimit: vi.fn(async (size: number) => size > getMaxFileSize()),
    };
});

vi.mock("./thumbnail", () => ({
    generateThumbnail: vi.fn().mockResolvedValue(null),
}));

vi.mock("./file-service", () => ({
    FileService: { createFromUpload: createFromUploadMock },
}));

vi.mock("./upload-errors", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./upload-errors")>();
    return {
        ...actual,
        sleep: () => Promise.resolve(),
        retryBackoffMs: () => 0,
    };
});

import { getMaxFileSize } from "./limits";
import { uploadChunks, uploadFile } from "./upload";
import { uploadSourceFromFile } from "./upload-source";

function pngBytes(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

describe("uploadFile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getDBGetMock.mockResolvedValue(undefined);
        openUploadSessionMock.mockResolvedValue({ chunk_set_id: "cs-test-1" });
        mintUploadUrlsMock.mockResolvedValue([{ index: 0, put_url: "https://example/put/0" }]);
        // A reset (not just a clear) — the abort test leaves a never-resolving implementation behind
        putChunkMock.mockReset().mockResolvedValue(undefined);
        finalizeUploadMock.mockReset().mockResolvedValue(undefined);
        abortUploadMock.mockReset().mockResolvedValue(undefined);
        encryptChunkTaskMock.mockImplementation(async () => ({
            ciphertext: new Uint8Array([1, 2, 3]),
            nonce: new Uint8Array([4, 5, 6]),
        }));
        generateItemKeyTaskMock.mockResolvedValue({
            encryptedItemKey: new Uint8Array([7, 8, 9]),
            itemKeyNonce: new Uint8Array([10, 11, 12]),
        });
        encryptPayloadTaskMock.mockResolvedValue({
            ciphertext: new Uint8Array([13, 14, 15]),
            nonce: new Uint8Array([16, 17, 18]),
        });
    });

    it("rejects files over the per-user size limit", async () => {
        vi.mocked(getMaxFileSize).mockReturnValue(100);
        const file = new File([new Uint8Array(200)], "big.bin", {
            type: "application/octet-stream",
        });

        await expect(uploadFile(file, null)).rejects.toThrow("File too large");
        expect(openUploadSessionMock).not.toHaveBeenCalled();
    });

    it("encrypts chunks, lazy-mints URL, finalizes session, and commits file item", async () => {
        const file = new File([pngBytes()], "photo.png", { type: "image/png" });
        const phases: string[] = [];

        const item = await uploadFile(file, "parent-folder", {
            itemId: "file-fixed-1",
            onProgress: (p) => phases.push(p.phase),
        });

        expect(openUploadSessionMock).toHaveBeenCalledOnce();
        expect(openUploadSessionMock).toHaveBeenCalledWith(1, file.size + FILE_LIMITS.AEAD_TAG, [
            file.size + FILE_LIMITS.AEAD_TAG,
        ]);
        expect(mintUploadUrlsMock).toHaveBeenCalledWith("cs-test-1", [0]);
        expect(encryptChunkTaskMock).toHaveBeenCalledOnce();
        expect(putChunkMock).toHaveBeenCalledOnce();
        expect(finalizeUploadMock).toHaveBeenCalledWith("cs-test-1");
        expect(createFromUploadMock).toHaveBeenCalledOnce();
        expect(item.id).toBe("file-fixed-1");
        expect(item.parent_id).toBe("parent-folder");
        expect(item.type).toBe("file");
        expect(phases).toEqual(["encrypting", "uploading", "finalizing", "committing", "done"]);
    });

    it("aborts in-flight upload and reclaims the chunk session on user abort", async () => {
        putChunkMock.mockImplementation(() => new Promise(() => {}));
        const file = new File([pngBytes()], "hang.png", { type: "image/png" });
        const ac = new AbortController();

        const uploadPromise = uploadFile(file, null, {
            itemId: "file-abort-1",
            signal: ac.signal,
        });

        await Promise.resolve();
        ac.abort();

        await expect(uploadPromise).rejects.toBeInstanceOf(DOMException);
        expect(abortUploadMock).toHaveBeenCalledWith("cs-test-1");
        expect(createFromUploadMock).not.toHaveBeenCalled();
    });

    it("does not abort session on transient network failure", async () => {
        putChunkMock
            .mockRejectedValueOnce(new Error("Network error during upload"))
            .mockResolvedValueOnce(undefined);

        const file = new File([pngBytes()], "retry.png", { type: "image/png" });
        await uploadFile(file, null, { itemId: "file-retry-1" });

        expect(putChunkMock).toHaveBeenCalledTimes(2);
        expect(abortUploadMock).not.toHaveBeenCalled();
        expect(finalizeUploadMock).toHaveBeenCalledWith("cs-test-1");
    });

    it("mints a fresh PUT URL when the object store rejects the signature (expired presign)", async () => {
        // A presigned URL lives PRESIGNED_PUT_EXPIRES_SEC; a retry that reuses the cached (or
        // pre-minted) one after a 403 would just 403 again until the retries run out.
        mintUploadUrlsMock
            .mockResolvedValueOnce([{ index: 0, put_url: "https://example/put/0?sig=old" }])
            .mockResolvedValueOnce([{ index: 0, put_url: "https://example/put/0?sig=new" }]);
        const denied = Object.assign(new Error("Upload failed: storage access denied (403)"), {
            status: 403,
        });
        putChunkMock.mockRejectedValueOnce(denied).mockResolvedValueOnce(undefined);

        const file = new File([pngBytes()], "expired.png", { type: "image/png" });
        await uploadFile(file, null, { itemId: "file-remint-1" });

        expect(mintUploadUrlsMock).toHaveBeenCalledTimes(2);
        expect(putChunkMock).toHaveBeenNthCalledWith(
            1,
            "https://example/put/0?sig=old",
            expect.anything(),
            expect.anything(),
        );
        expect(putChunkMock).toHaveBeenNthCalledWith(
            2,
            "https://example/put/0?sig=new",
            expect.anything(),
            expect.anything(),
        );
        expect(abortUploadMock).not.toHaveBeenCalled();
        expect(finalizeUploadMock).toHaveBeenCalledWith("cs-test-1");
    });

    it("mints a fresh PUT URL when the object store rejects a baked-in checksum (400 BadDigest)", async () => {
        // Garage validates the unsigned x-amz-checksum-crc32 query param baked into the
        // presigned URL and rejects it with 400 BadDigest — reusing that same URL would 400
        // identically forever, so this must re-mint exactly like the 403 case above.
        mintUploadUrlsMock
            .mockResolvedValueOnce([{ index: 0, put_url: "https://example/put/0?sig=old" }])
            .mockResolvedValueOnce([{ index: 0, put_url: "https://example/put/0?sig=new" }]);
        const badDigest = Object.assign(new Error("Upload failed: 400 Bad Request (BadDigest)"), {
            status: 400,
            code: "BadDigest",
        });
        putChunkMock.mockRejectedValueOnce(badDigest).mockResolvedValueOnce(undefined);

        const file = new File([pngBytes()], "checksum-mismatch.png", { type: "image/png" });
        await uploadFile(file, null, { itemId: "file-remint-2" });

        expect(mintUploadUrlsMock).toHaveBeenCalledTimes(2);
        expect(putChunkMock).toHaveBeenNthCalledWith(
            1,
            "https://example/put/0?sig=old",
            expect.anything(),
            expect.anything(),
        );
        expect(putChunkMock).toHaveBeenNthCalledWith(
            2,
            "https://example/put/0?sig=new",
            expect.anything(),
            expect.anything(),
        );
        expect(abortUploadMock).not.toHaveBeenCalled();
        expect(finalizeUploadMock).toHaveBeenCalledWith("cs-test-1");
    });

    // Before, a 400 the store keeps giving was "transient" — 8 attempts and ~2 min of backoff, then
    // `paused`, which only scheduled the same refusal again later.
    it("fails with fatal_storage when a fresh URL is refused as well (400 InvalidDigest)", async () => {
        mintUploadUrlsMock
            .mockResolvedValueOnce([{ index: 0, put_url: "https://example/put/0?sig=old" }])
            .mockResolvedValueOnce([{ index: 0, put_url: "https://example/put/0?sig=new" }]);
        const refused = () =>
            Object.assign(new Error("Upload failed: 400 Bad Request (InvalidDigest)"), {
                status: 400,
                code: "InvalidDigest",
            });
        putChunkMock.mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused());

        const file = new File([pngBytes()], "refused.png", { type: "image/png" });
        const error = await uploadFile(file, null, { itemId: "file-refused-1" }).catch((e) => e);

        expect(error).toMatchObject({
            name: "UploadPipelineError",
            errorClass: "fatal_storage",
            phase: "failed_recoverable",
            message: "Upload failed: 400 Bad Request (InvalidDigest)",
        });
        expect(putChunkMock).toHaveBeenCalledTimes(2);
        expect(putChunkMock).toHaveBeenNthCalledWith(
            2,
            "https://example/put/0?sig=new",
            expect.anything(),
            expect.anything(),
        );
        expect(mintUploadUrlsMock).toHaveBeenCalledTimes(2);
        expect(finalizeUploadMock).not.toHaveBeenCalled();
        expect(abortUploadMock).not.toHaveBeenCalled();
    });

    // One refusal is not yet a verdict — the fresh URL may well be accepted.
    it("recovers when a single 400 is followed by an accepted PUT on a fresh URL", async () => {
        mintUploadUrlsMock
            .mockResolvedValueOnce([{ index: 0, put_url: "https://example/put/0?sig=old" }])
            .mockResolvedValueOnce([{ index: 0, put_url: "https://example/put/0?sig=new" }]);
        const refused = Object.assign(new Error("Upload failed: 400 Bad Request"), { status: 400 });
        putChunkMock.mockRejectedValueOnce(refused).mockResolvedValueOnce(undefined);

        const file = new File([pngBytes()], "once.png", { type: "image/png" });
        await uploadFile(file, null, { itemId: "file-refused-2" });

        expect(putChunkMock).toHaveBeenCalledTimes(2);
        expect(putChunkMock).toHaveBeenNthCalledWith(
            2,
            "https://example/put/0?sig=new",
            expect.anything(),
            expect.anything(),
        );
        expect(finalizeUploadMock).toHaveBeenCalledWith("cs-test-1");
    });

    it("reuses existing Item Key + version when re-uploading same item id (backup restore)", async () => {
        // base64 of [1,2,3] and [4,5,6]
        getDBGetMock.mockResolvedValue({
            id: "file-restore-1",
            type: "file",
            encrypted_item_key: "AQID",
            item_key_nonce: "BAUG",
            version: 9,
            localRev: 4,
        });

        const file = new File([pngBytes()], "restored.png", { type: "image/png" });
        const item = await uploadFile(file, null, { itemId: "file-restore-1" });

        expect(generateItemKeyTaskMock).not.toHaveBeenCalled();
        expect(addCachedItemKeyMock).toHaveBeenCalledOnce();
        // encryptPayloadTask(itemId, payload, version) — the version has to be 9, not 1
        expect(encryptPayloadTaskMock).toHaveBeenCalledWith(
            "file-restore-1",
            expect.any(Object),
            9,
        );
        expect(item.version).toBe(9);
        expect(item.localRev).toBe(5);
        expect(createFromUploadMock).toHaveBeenCalledOnce();
    });

    it("uploadChunks releases chunk ciphertext after each confirmed chunk", async () => {
        const file = new File([new Uint8Array(15)], "multichunk.bin", {
            type: "application/octet-stream",
        });
        const ciphertextCache = new Map<number, Uint8Array>();

        await uploadChunks({
            source: uploadSourceFromFile(file),
            itemId: "item-1",
            chunkSetId: "cs-1",
            putUrls: ["https://example/put/0", "https://example/put/1", "https://example/put/2"],
            totalChunks: 3,
            chunkSize: 5,
            onProgress: () => {},
            ciphertextCache,
        });

        expect(ciphertextCache.size).toBe(0);
    });
});
