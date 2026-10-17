// Classifying upload errors — transient ≠ abort the session.
import { ApiError } from "$lib/core/api/client";

export type UploadErrorClass =
    | "transient"
    | "user"
    | "fatal_session"
    | "fatal_quota"
    | "fatal_integrity"
    /** The object store refuses the request itself — see `isPermanentStorageRejection`. */
    | "fatal_storage";

export class UploadPipelineError extends Error {
    readonly errorClass: UploadErrorClass;
    readonly phase: "paused" | "failed_expired" | "failed_recoverable";

    constructor(
        message: string,
        errorClass: UploadErrorClass,
        phase: "paused" | "failed_expired" | "failed_recoverable",
    ) {
        super(message);
        this.name = "UploadPipelineError";
        this.errorClass = errorClass;
        this.phase = phase;
    }
}

export function isUserAbort(err: unknown): boolean {
    if (err instanceof DOMException && err.name === "AbortError") return true;
    if (err instanceof Error && err.message === "Upload aborted") return true;
    return false;
}

function messageOf(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

/**
 * The upload API's own codes (`server/src/routes/files.ts`) and what each means for the upload.
 * `incomplete` is the one conflict worth retrying: the resume sends the missing chunks.
 */
const API_ERROR_CLASSES: Readonly<Record<string, UploadErrorClass>> = {
    no_session: "fatal_session",
    restore_session_not_found: "fatal_session",
    session_not_uploading: "fatal_session",
    restore_session_not_open: "fatal_session",
    already_committed: "fatal_session",
    restore_session_expired: "fatal_session",
    incomplete: "transient",
    quota_exceeded: "fatal_quota",
    file_too_large: "fatal_quota",
    too_many_uploads: "transient",
    too_many_restore_uploads: "transient",
    bad_chunk_index: "fatal_integrity",
    bad_chunk_set_id: "fatal_integrity",
    duplicate_indices: "fatal_integrity",
    invalid_session_chunk_sizes: "fatal_integrity",
};

/** An upload API refusal, by its code and — for a code this client does not know — its status. */
function classifyApiError(err: ApiError): UploadErrorClass {
    const known = API_ERROR_CLASSES[err.message];
    if (known) return known;
    if (err.status === 413) return "fatal_quota";
    if (err.status === 404 || err.status === 410) return "fatal_session";
    // Other 5xx, 429 and the rest: retrying is safer than giving the session up.
    return "transient";
}

/** Maps a throw onto an error class, for the retry/abort decision. */
export function classifyUploadError(err: unknown): UploadErrorClass {
    if (isUserAbort(err)) return "user";
    // The upload API answers with a status and a code — never read its text.
    if (err instanceof ApiError) return classifyApiError(err);

    // Below: what is not an API answer — the object store's PUT, the network, and the
    // pipeline's own errors.
    const msg = messageOf(err).toLowerCase();

    if (msg.includes("quota") || msg.includes("413") || msg.includes("storage full")) {
        return "fatal_quota";
    }
    // Object-store misconfig (missing bucket) — not an upload-session problem; do not abort
    // session classification as if the server deleted the session mid-flight.
    if (
        msg.includes("bucket missing") ||
        msg.includes("nosuchbucket") ||
        msg.includes("misconfigured")
    ) {
        return "fatal_integrity";
    }
    if (
        msg.includes("404") ||
        msg.includes("not found") ||
        msg.includes("expired") ||
        msg.includes("already committed") ||
        msg.includes("409")
    ) {
        return "fatal_session";
    }
    if (msg.includes("integrity") || msg.includes("missing ciphertext")) {
        return "fatal_integrity";
    }
    if (
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("failed to fetch") ||
        msg.includes("url expired") ||
        msg.includes("403") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("504")
    ) {
        return "transient";
    }

    // An unknown error — treat it as transient (safer than aborting the session).
    return "transient";
}

/**
 * The text a failed upload shows. An upload API refusal carries a code, not a sentence;
 * `file_too_large` also carries the limit — the one a file staged offline, with no limit known,
 * learns only here.
 */
export function uploadErrorMessage(err: unknown): string {
    if (err instanceof ApiError && err.message === "file_too_large") {
        const max = err.body?.max_file_size;
        if (typeof max === "number" && max > 0) {
            return `Too large — the limit is ${Math.floor(max / (1024 * 1024))} MB`;
        }
    }
    return err instanceof Error ? err.message : "Upload failed";
}

export function retryBackoffMs(attempt: number): number {
    // 1s, 2s, 4s, … capped at 60s (attempt is 1-based).
    return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
