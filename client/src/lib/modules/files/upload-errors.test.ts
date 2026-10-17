import { describe, expect, it } from "vitest";
import { ApiError } from "$lib/core/api/client";
import {
    classifyUploadError,
    isUserAbort,
    retryBackoffMs,
    uploadErrorMessage,
} from "./upload-errors";

describe("classifyUploadError", () => {
    it("classifies AbortError as user", () => {
        expect(classifyUploadError(new DOMException("aborted", "AbortError"))).toBe("user");
        expect(isUserAbort(new DOMException("aborted", "AbortError"))).toBe(true);
    });

    it("classifies network errors as transient", () => {
        expect(classifyUploadError(new Error("Network error during upload"))).toBe("transient");
        expect(classifyUploadError(new TypeError("Failed to fetch"))).toBe("transient");
    });

    it("classifies 404 session as fatal_session", () => {
        expect(classifyUploadError(new Error("Upload session not found (404)"))).toBe(
            "fatal_session",
        );
    });

    it("classifies missing S3 bucket as fatal_integrity (not session)", () => {
        expect(
            classifyUploadError(
                new Error(
                    "Upload failed: S3 bucket missing (dev: restart API or `docker compose up -d garage garage_init`)",
                ),
            ),
        ).toBe("fatal_integrity");
        expect(
            classifyUploadError(
                new Error("Upload failed: file storage is misconfigured (bucket not found)"),
            ),
        ).toBe("fatal_integrity");
    });

    it("classifies quota errors as fatal_quota", () => {
        expect(classifyUploadError(new Error("Storage quota exceeded (413)"))).toBe("fatal_quota");
    });
});

// Every code the upload routes really send (`server/src/routes/files.ts`), thrown the way
// `jsonOrThrow` throws them. Before, the text alone reached the classifier and 9 of these 12 read
// as transient, so an upload retried forever against a session that was gone.
describe("classifyUploadError — upload API errors by status and code", () => {
    const TABLE: Array<[code: string, status: number, expected: string]> = [
        ["no_session", 404, "fatal_session"],
        ["restore_session_not_found", 404, "fatal_session"],
        ["session_not_uploading", 409, "fatal_session"],
        ["restore_session_not_open", 409, "fatal_session"],
        ["already_committed", 409, "fatal_session"],
        ["incomplete", 409, "transient"],
        ["restore_session_expired", 410, "fatal_session"],
        ["quota_exceeded", 413, "fatal_quota"],
        ["file_too_large", 413, "fatal_quota"],
        ["too_many_uploads", 429, "transient"],
        ["too_many_restore_uploads", 429, "transient"],
        ["bad_chunk_index", 400, "fatal_integrity"],
        ["bad_chunk_set_id", 400, "fatal_integrity"],
        ["duplicate_indices", 400, "fatal_integrity"],
        ["invalid_session_chunk_sizes", 500, "fatal_integrity"],
    ];

    it.each(TABLE)("%s (%i) → %s", (code, status, expected) => {
        expect(classifyUploadError(new ApiError(code, status, { error: code }))).toBe(expected);
    });

    it("an unknown code falls back on its status; a 5xx is worth a retry", () => {
        expect(classifyUploadError(new ApiError("Not Found", 404))).toBe("fatal_session");
        expect(classifyUploadError(new ApiError("Gone", 410))).toBe("fatal_session");
        expect(classifyUploadError(new ApiError("Payload Too Large", 413))).toBe("fatal_quota");
        expect(classifyUploadError(new ApiError("Bad Gateway", 502))).toBe("transient");
        expect(classifyUploadError(new ApiError("Internal Server Error", 500))).toBe("transient");
    });
});

describe("uploadErrorMessage", () => {
    it("names the server's limit when it refuses a file as too large", () => {
        const err = new ApiError("file_too_large", 413, {
            error: "file_too_large",
            max_file_size: 100 * 1024 * 1024,
        });
        expect(uploadErrorMessage(err)).toBe("Too large — the limit is 100 MB");
    });

    it("keeps the code when there is no limit to name, and any other error's own message", () => {
        expect(uploadErrorMessage(new ApiError("file_too_large", 413, {}))).toBe("file_too_large");
        expect(uploadErrorMessage(new ApiError("quota_exceeded", 413))).toBe("quota_exceeded");
        expect(uploadErrorMessage(new Error("Network error"))).toBe("Network error");
        expect(uploadErrorMessage("boom")).toBe("Upload failed");
    });
});

describe("retryBackoffMs", () => {
    it("caps exponential backoff at 60s", () => {
        expect(retryBackoffMs(1)).toBe(1000);
        expect(retryBackoffMs(2)).toBe(2000);
        expect(retryBackoffMs(10)).toBe(60_000);
    });
});
