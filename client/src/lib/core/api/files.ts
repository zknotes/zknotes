// Raw-fetch helpers for the file upload endpoints. Kept apart from `apiFetch` because the
// chunks are binary octet-stream rather than JSON.
import { FILE_LIMITS } from "@zknotes/shared";
import { API_BASE, ApiError } from "./client";

/**
 * A refused upload call throws `ApiError(code, status, body)`: the classifier decides by status and
 * code, never by the text, and the body carries details such as `max_file_size`.
 */
async function jsonOrThrow<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let body: Record<string, unknown> = {};
        try {
            body = (await res.json()) as Record<string, unknown>;
        } catch {
            // Not JSON — the status text stands in for the code.
        }
        const code = typeof body.error === "string" ? body.error : res.statusText;
        throw new ApiError(code || "Request failed", res.status, body);
    }
    return res.json() as Promise<T>;
}

/** POST /uploads — opens a session and returns the chunk_set_id (with no bulk put_urls). */
export async function openUploadSession(
    expectedChunks: number,
    totalSize: number,
    chunkSizes: number[],
    restoreSessionId?: string,
): Promise<{ chunk_set_id: string }> {
    const res = await fetch(`${API_BASE}/uploads`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            expected_chunks: expectedChunks,
            total_size: totalSize,
            chunk_sizes: chunkSizes,
            ...(restoreSessionId ? { restore_session_id: restoreSessionId } : {}),
        }),
    });
    return jsonOrThrow<{ chunk_set_id: string }>(res);
}

/** POST /uploads/:chunkSetId/urls — lazy mint of presigned PUT URLs. */
export async function mintUploadUrls(
    chunkSetId: string,
    indices: number[],
): Promise<{ index: number; put_url: string }[]> {
    const res = await fetch(`${API_BASE}/uploads/${chunkSetId}/urls`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indices }),
    });
    const body = await jsonOrThrow<{ urls: { index: number; put_url: string }[] }>(res);
    return body.urls;
}

/**
 * Opens a session and fetches every presigned PUT URL in batches (for compatibility with upload.ts).
 */
export async function openUpload(
    expectedChunks: number,
    totalSize: number,
    chunkSizes: number[],
): Promise<{ chunk_set_id: string; put_urls: string[] }> {
    const { chunk_set_id } = await openUploadSession(expectedChunks, totalSize, chunkSizes);
    const put_urls: string[] = [];
    const batch = FILE_LIMITS.MINT_URLS_MAX_INDICES;
    for (let start = 0; start < expectedChunks; start += batch) {
        const indices = Array.from(
            { length: Math.min(batch, expectedChunks - start) },
            (_, i) => start + i,
        );
        const urls = await mintUploadUrls(chunk_set_id, indices);
        for (const { index, put_url } of urls) {
            put_urls[index] = put_url;
        }
    }
    return { chunk_set_id, put_urls };
}

/** POST /uploads/:chunkSetId/ping — a heartbeat against the GC of stale sessions. */
export async function pingUploadSession(
    chunkSetId: string,
): Promise<{ ok: boolean; session_status: string }> {
    const res = await fetch(`${API_BASE}/uploads/${chunkSetId}/ping`, {
        method: "POST",
        credentials: "include",
    });
    return jsonOrThrow<{ ok: boolean; session_status: string }>(res);
}

/** GET /uploads/:chunkSetId/status — the batch status of the chunks on S3. */
export async function getUploadStatus(chunkSetId: string): Promise<{
    session_status: string;
    expected_chunks: number;
    expected_size: number;
    present_indices: number[];
    total_present_size: number;
}> {
    const res = await fetch(`${API_BASE}/uploads/${chunkSetId}/status`, {
        credentials: "include",
    });
    return jsonOrThrow(res);
}

function s3PutErrorMessage(status: number, statusText: string, body: string): string {
    // The Garage/S3 XML: <Code>NoSuchBucket</Code> — the statusText "Not Found" is misleading
    // (it looks like "upload session not found" when in fact the object-store bucket is missing).
    const code = body.match(/<Code>([^<]+)<\/Code>/i)?.[1];
    if (code === "NoSuchBucket" || (status === 404 && /nosuchbucket/i.test(body))) {
        return import.meta.env.DEV
            ? "Upload failed: S3 bucket missing (dev: restart API or `docker compose up -d garage garage_init`)"
            : "Upload failed: file storage is misconfigured (bucket not found)";
    }
    if (status === 403 || code === "AccessDenied" || code === "SignatureDoesNotMatch") {
        return `Upload failed: storage access denied (${code ?? status})`;
    }
    if (status >= 500) {
        return `Upload failed: storage temporarily unavailable (${status})`;
    }
    return `Upload failed: ${status} ${statusText || "error"}${code ? ` (${code})` : ""}`;
}

/**
 * A rejected presigned PUT. `status` lets the upload loop tell an expired or rejected signature
 * (403 — re-mint the URL and retry) from a storage outage (5xx — retry the same URL).
 */
export class S3PutError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = "S3PutError";
        this.status = status;
        this.code = code;
    }
}

/**
 * True when the object store refused the signature itself — the URL must be minted again.
 * Covers both an expired/invalid signature (403) and a checksum baked into the signed query
 * string that a Garage/MinIO can never satisfy (400 BadDigest/InvalidDigest — see the comment on
 * `requestChecksumCalculation` in server/src/s3.ts). Either way the same URL is doomed to fail
 * identically on every retry, so it must be discarded rather than reused.
 */
export function isPresignRejected(err: unknown): boolean {
    return (
        err instanceof S3PutError &&
        (err.status === 403 ||
            err.code === "AccessDenied" ||
            err.code === "SignatureDoesNotMatch" ||
            err.code === "RequestTimeTooSkewed" ||
            err.code === "BadDigest" ||
            err.code === "InvalidDigest")
    );
}

// 4xx statuses that are not a verdict on the request itself: 403 is the signature (re-mint), 404/409
// already end the session or name a missing bucket, 413 is the quota, and 408/429 are timing.
const RETRYABLE_4XX_STATUSES = new Set([403, 404, 408, 409, 413, 429]);
// S3 codes that AWS sends as a plain 400 although a retry does help.
const RETRYABLE_4XX_CODES = new Set([
    "RequestTimeout",
    "IncompleteBody",
    "SlowDown",
    "RequestTimeTooSkewed",
    "ExpiredToken",
]);

/**
 * True when the object store refused the request itself (a 4xx that is not about the signature,
 * the session, the quota or timing). Resending the same bytes cannot change that answer, so the
 * upload loop gives it one freshly minted URL and then fails instead of retrying for minutes.
 * BadDigest/InvalidDigest count: the first one re-mints through `isPresignRejected`, a second one
 * on a fresh URL means the server itself keeps signing an unsatisfiable checksum.
 */
export function isPermanentStorageRejection(err: unknown): boolean {
    return (
        err instanceof S3PutError &&
        err.status >= 400 &&
        err.status < 500 &&
        !RETRYABLE_4XX_STATUSES.has(err.status) &&
        !(err.code !== undefined && RETRYABLE_4XX_CODES.has(err.code))
    );
}

export function putChunk(
    putUrl: string,
    ciphertext: Uint8Array,
    onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", putUrl);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");

        if (onProgress) {
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    onProgress(e.loaded, e.total);
                }
            };
        }

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
            } else {
                const body = xhr.responseText || "";
                const code = body.match(/<Code>([^<]+)<\/Code>/i)?.[1];
                reject(
                    new S3PutError(
                        s3PutErrorMessage(xhr.status, xhr.statusText, body),
                        xhr.status,
                        code,
                    ),
                );
            }
        };

        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.send(new Blob([ciphertext as BlobPart]));
    });
}

/** POST finalize — validates completeness and commits the set. */
export async function finalizeUpload(chunkSetId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/uploads/${chunkSetId}/finalize`, {
        method: "POST",
        credentials: "include",
    });
    await jsonOrThrow(res);
}

/** DELETE — aborts an upload in progress (returning the quota and deleting the chunks). */
export async function abortUpload(chunkSetId: string): Promise<void> {
    try {
        await fetch(`${API_BASE}/uploads/${chunkSetId}`, {
            method: "DELETE",
            credentials: "include",
        });
    } catch {
        // best effort; GC reclaims it anyway
    }
}

/** Fetches a chunk's presigned GET URL; `bustCache` bypasses the HTTP cache. */
async function fetchChunkUrl(
    chunkSetId: string,
    index: number,
    bustCache: boolean,
): Promise<string> {
    const res = await fetch(`${API_BASE}/uploads/${chunkSetId}/chunks/${index}`, {
        credentials: "include",
        ...(bustCache ? { cache: "reload" as RequestCache } : {}),
    });
    if (!res.ok) throw new Error(`chunk ${index} fetch failed (${res.status})`);
    const { url } = await res.json();
    return url as string;
}

async function fetchChunkBytes(index: number, url: string): Promise<Response> {
    try {
        return await fetch(url);
    } catch {
        // Typically an ERR_CONNECTION_REFUSED when Garage is not running (in dev: docker compose up -d garage)
        throw new Error(
            import.meta.env.DEV
                ? `S3 storage unavailable — file storage is not running. Run: docker compose up -d garage`
                : `File storage is temporarily unavailable. Please try again later.`,
        );
    }
}

/** GET the ciphertext of one chunk as raw bytes. */
export async function getChunk(chunkSetId: string, index: number): Promise<Uint8Array> {
    let chunkRes = await fetchChunkBytes(index, await fetchChunkUrl(chunkSetId, index, false));

    // The signature is valid for 1 h, and the JSON carrying it may come from an HTTP cache (ours or
    // someone else's). An expired signature gives a 403 or 401 from S3 — fetch a fresh URL with a
    // cache bust and retry EXACTLY once. Without this the user sees "File storage is temporarily
    // unavailable" until the cache expires of its own accord.
    if (chunkRes.status === 403 || chunkRes.status === 401) {
        chunkRes = await fetchChunkBytes(index, await fetchChunkUrl(chunkSetId, index, true));
    }

    if (!chunkRes.ok) throw new Error(`chunk ${index} S3 fetch failed (${chunkRes.status})`);
    return new Uint8Array(await chunkRes.arrayBuffer());
}

/**
 * A cheap existence check for a chunk (HEAD — Fastify serves it automatically for a GET route, with no body).
 * It tells a definitive 404 from a transient error, so callers never prune on a flaky network.
 */
export async function chunkStatus(
    chunkSetId: string,
    index: number,
): Promise<"ok" | "missing" | "error"> {
    try {
        const res = await fetch(`${API_BASE}/uploads/${chunkSetId}/chunks/${index}`, {
            method: "HEAD",
            credentials: "include",
        });
        if (res.ok) return "ok";
        if (res.status === 404) return "missing";
        return "error";
    } catch {
        return "error";
    }
}

/** GET /me/storage — the quota for the UI bar + the per-user max file size + the plan. */
export async function getStorage(): Promise<{
    breakdown: {
        files_bytes: number;
        items_bytes: number;
        history_bytes: number;
        trashed_bytes: number;
        total_used: number;
    };
    storage_quota: number;
    max_file_size: number;
    /** `null` on a self-host — the plan row is then not shown. */
    plan_label: string | null;
    /** The concrete share TTL allowed; the client filters the options by it. */
    max_share_ttl_sec: number;
}> {
    const res = await fetch(`${API_BASE}/me/storage`, {
        credentials: "include",
        cache: "no-store",
    });
    return jsonOrThrow<{
        breakdown: {
            files_bytes: number;
            items_bytes: number;
            history_bytes: number;
            trashed_bytes: number;
            total_used: number;
        };
        storage_quota: number;
        max_file_size: number;
        plan_label: string | null;
        max_share_ttl_sec: number;
    }>(res);
}
