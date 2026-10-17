// The per-user maximum file size. The source of truth is `users.max_file_size` on the server
// (enforced in POST /uploads); the client caches it here for synchronous UX checks (an editor drop, an
// upload call)
// so the user gets a clear message BEFORE the encryption and the upload, rather than a 413 halfway through.
//
// Unknown until GET /me/storage answers: a compile-time default would pull a per-account figure
// into the bundle and change the manifestHash whenever the limit changed. An unknown limit refuses
// nothing — an offline cold start stages the file, and the server decides at POST /uploads
// (`413 file_too_large`). A size check asks isOverFileSizeLimit(), which refreshes the cache first
// when it has to.

let maxFileSize: number | null = null;

/**
 * The last known per-user limit in bytes; `0` until the server answers. As a cap on reading — a
 * remote image fetch — an unknown limit allows nothing; for a refusal ask isOverFileSizeLimit().
 */
export function getMaxFileSize(): number {
    return maxFileSize ?? 0;
}

/** Whether a GET /me/storage has returned the limit in this page session. */
export function isMaxFileSizeKnown(): boolean {
    return maxFileSize !== null;
}

/** Whether `size` is over the limit this client knows — synchronous; an unknown limit refuses nothing. */
export function exceedsKnownFileSizeLimit(size: number): boolean {
    return maxFileSize !== null && size > maxFileSize;
}

/**
 * Whether a file of `size` bytes is over the per-user limit. The cache is refreshed first when the
 * size is above it or the limit is not known; a limit that is still not known refuses nothing, and
 * the server decides.
 */
export async function isOverFileSizeLimit(size: number): Promise<boolean> {
    if (maxFileSize !== null && size <= maxFileSize) return false;
    await refreshFileLimits();
    return exceedsKnownFileSizeLimit(size);
}

/** The limit in whole MB, for messages to the user. */
export function getMaxFileSizeMB(): number {
    return Math.floor(getMaxFileSize() / (1024 * 1024));
}

/**
 * Fetches the limit from the server (GET /me/storage). Call it on app load; best effort — on an error
 * the previous value stays if there is one, otherwise the limit stays unknown. The server is
 * authoritative anyway.
 */
export async function refreshFileLimits(): Promise<void> {
    try {
        const { getStorage } = await import("$lib/core/api");
        const { max_file_size } = await getStorage();
        if (Number.isFinite(max_file_size) && max_file_size > 0) maxFileSize = max_file_size;
    } catch (err) {
        // A 401 with no session (the login shell, or an old cookie) — expected; the limit stays unknown.
        if (err instanceof Error && /unauthorized|401/i.test(err.message)) {
            return;
        }
        console.error("Failed to refresh file limits:", err);
        // offline — keep the previous cache, or an unknown limit when there is none
    }
}
