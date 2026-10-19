import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setUnauthorizedHandler, UnauthorizedError } from "./client";
import {
    S3PutError,
    getChunk,
    isPermanentStorageRejection,
    isPresignRejected,
    openUploadSession,
    pingUploadSession,
} from "./files";

// A presigned URL is valid for 1 h, while the JSON carrying it may come out of an HTTP
// cache (our own Caddy used to rewrite that to 24 h; someone else's proxy or CDN we do not control).
// On an expired signature S3 answers 403 — the client then fetches a fresh URL ONCE with a cache-bust
// and retries.

type FetchCall = { url: string; init?: RequestInit };

function bytes(...values: number[]): Response {
    return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array(values).buffer,
    } as unknown as Response;
}

function json(url: string): Response {
    return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ url }),
    } as unknown as Response;
}

function status(code: number, body?: Record<string, unknown>): Response {
    return {
        ok: false,
        status: code,
        statusText: `status ${code}`,
        json: async () => {
            if (!body) throw new SyntaxError("not json");
            return body;
        },
    } as unknown as Response;
}

let calls: FetchCall[];

function installFetch(responses: Response[]) {
    let i = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const res = responses[i++];
        if (!res) throw new Error(`unexpected fetch #${i}: ${url}`);
        return Promise.resolve(res);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

beforeEach(() => {
    calls = [];
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setUnauthorizedHandler(null);
});

// The JSON upload calls share the one transport, so an expired session during an upload locks the
// vault like anywhere else, and a refusal carries the server's body for the classifier.
describe("upload session calls go through apiFetch", () => {
    it("a 401 on the heartbeat runs the session teardown handler", async () => {
        const onUnauthorized = vi.fn();
        setUnauthorizedHandler(onUnauthorized);
        installFetch([status(401, { error: "unauthorized" })]);

        await expect(pingUploadSession("cs1")).rejects.toBeInstanceOf(UnauthorizedError);
        expect(onUnauthorized).toHaveBeenCalledWith("expired");
        expect(calls[0]?.url).toBe("/uploads/cs1/ping");
        expect(calls[0]?.init?.credentials).toBe("include");
    });

    it("a refused open carries the code and the body", async () => {
        installFetch([status(413, { error: "file_too_large", max_file_size: 1024 })]);

        const err = await openUploadSession(1, 2048, [2048]).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(413);
        expect((err as ApiError).message).toBe("file_too_large");
        expect((err as ApiError).body).toEqual({ error: "file_too_large", max_file_size: 1024 });
    });
});

describe("getChunk", () => {
    it("returns chunk bytes without any retry on the healthy path", async () => {
        installFetch([json("https://s3.example/a"), bytes(1, 2, 3)]);

        await expect(getChunk("cs-1", 0)).resolves.toEqual(new Uint8Array([1, 2, 3]));

        expect(calls).toHaveLength(2);
        expect(calls.every((c) => c.init?.cache !== "reload")).toBe(true);
    });

    it("re-fetches a fresh presigned URL once when S3 rejects an expired signature", async () => {
        installFetch([
            json("https://s3.example/stale"),
            status(403),
            json("https://s3.example/fresh"),
            bytes(9, 9),
        ]);

        await expect(getChunk("cs-1", 2)).resolves.toEqual(new Uint8Array([9, 9]));

        expect(calls).toHaveLength(4);
        expect(calls[1]?.url).toBe("https://s3.example/stale");
        expect(calls[2]?.init?.cache).toBe("reload");
        expect(calls[3]?.url).toBe("https://s3.example/fresh");
    });

    it("gives up after a single retry", async () => {
        installFetch([
            json("https://s3.example/stale"),
            status(403),
            json("https://s3.example/also-stale"),
            status(403),
        ]);

        await expect(getChunk("cs-1", 1)).rejects.toThrow(/403/);
        expect(calls).toHaveLength(4);
    });

    it("does not retry on a non-auth S3 status", async () => {
        installFetch([json("https://s3.example/gone"), status(404)]);

        await expect(getChunk("cs-1", 0)).rejects.toThrow(/404/);
        expect(calls).toHaveLength(2);
    });

    it("keeps the storage-unavailable message when the S3 fetch throws", async () => {
        let i = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) => {
                calls.push({ url });
                if (i++ === 0) return Promise.resolve(json("https://s3.example/a"));
                return Promise.reject(new Error("ECONNREFUSED"));
            }),
        );

        await expect(getChunk("cs-1", 0)).rejects.toThrow(/storage/i);
        expect(calls).toHaveLength(2);
    });
});

describe("isPresignRejected", () => {
    it("is true for an expired/invalid signature (403 family)", () => {
        expect(isPresignRejected(new S3PutError("denied", 403))).toBe(true);
        expect(isPresignRejected(new S3PutError("denied", 400, "AccessDenied"))).toBe(true);
        expect(isPresignRejected(new S3PutError("denied", 400, "SignatureDoesNotMatch"))).toBe(
            true,
        );
        expect(isPresignRejected(new S3PutError("denied", 400, "RequestTimeTooSkewed"))).toBe(true);
    });

    // Garage/MinIO reject a checksum baked into the presigned query string with 400
    // BadDigest/InvalidDigest — that checksum can never match on retry, so the URL is just as
    // dead as an expired signature and must be re-minted, not resent.
    it("is true for a checksum baked into the signature (400 BadDigest/InvalidDigest)", () => {
        expect(isPresignRejected(new S3PutError("bad checksum", 400, "BadDigest"))).toBe(true);
        expect(isPresignRejected(new S3PutError("bad checksum", 400, "InvalidDigest"))).toBe(true);
    });

    it("is false for an unrelated 400 or a storage outage", () => {
        expect(isPresignRejected(new S3PutError("bad request", 400))).toBe(false);
        expect(isPresignRejected(new S3PutError("down", 503))).toBe(false);
        expect(isPresignRejected(new Error("network error"))).toBe(false);
    });
});

// A refusal of the request itself fails the upload after one fresh URL instead of
// retrying for minutes. Everything that is about the signature, the session, the quota or timing
// has to stay retryable, or a routine expired presign would start failing uploads.
describe("isPermanentStorageRejection", () => {
    it("is true for a 4xx the store gives about the request itself", () => {
        expect(isPermanentStorageRejection(new S3PutError("bad", 400))).toBe(true);
        expect(isPermanentStorageRejection(new S3PutError("bad", 400, "InvalidDigest"))).toBe(true);
        expect(isPermanentStorageRejection(new S3PutError("bad", 400, "BadDigest"))).toBe(true);
        expect(isPermanentStorageRejection(new S3PutError("bad", 405))).toBe(true);
        expect(isPermanentStorageRejection(new S3PutError("bad", 411))).toBe(true);
    });

    it("is false for the signature, the session, the quota and timing", () => {
        for (const status of [403, 404, 408, 409, 413, 429]) {
            expect(isPermanentStorageRejection(new S3PutError("retry", status))).toBe(false);
        }
    });

    it("is false for the 400 codes a retry does help with", () => {
        for (const code of [
            "RequestTimeout",
            "IncompleteBody",
            "SlowDown",
            "RequestTimeTooSkewed",
            "ExpiredToken",
        ]) {
            expect(isPermanentStorageRejection(new S3PutError("retry", 400, code))).toBe(false);
        }
    });

    it("is false for a storage outage or a network error", () => {
        expect(isPermanentStorageRejection(new S3PutError("down", 503))).toBe(false);
        expect(isPermanentStorageRejection(new Error("Network error during upload"))).toBe(false);
    });
});
