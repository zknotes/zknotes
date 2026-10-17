// The central decrypted-preview blob cache. One module owns every `blob:` URL minted from a
// decrypted file, so the file cards, the detail-panel preview and the editor's encFile nodes share
// one decrypt and one URL per file instead of each minting (and leaking) its own.
//
// Two layers, by design:
//   1. A ref count — callers `acquire` on mount/scroll-in and `release` on unmount/scroll-out. An entry
//      whose refs drop to 0 is NOT revoked at once; it stays so a re-mount can reuse it.
//   2. Two caps:
//        - SOFT_CAP: once the cache passes the limit, evict the OLDEST *released* (refs==0) entries.
//          Live entries (refs>0 = on screen right now) are never touched here — revoking the URL under
//          of a visible <img> is exactly what caused the ERR_FILE_NOT_FOUND thrash, and a virtualised
//          grid can legitimately mount more thumbnails in a row than a tidy ~30.
//        - HARD_CAP: an absolute ceiling. If we are above it, the only explanation is leaked releases
//          (Svelte 5's destroy timing is unreliable). Force-evict the oldest regardless of refs —
//          the real safety net against unbounded growth. An evicted URL is simply decrypted again on
//          the next acquire (cheap for a thumbnail).
//
// The render decision (raster vs download-only) is sniffed from the bytes and cached, so a
// download-only file is remembered as such and is not decrypted again every time a card scrolls into
// view.
import { decryptFile, getFilePayload } from "./download";
import { isRasterImageMime } from "./sniff";

export interface AcquiredPreview {
    /** The object URL for an inline raster preview, or null for download-only files. */
    url: string | null;
    render: "raster" | "video" | "audio" | "download";
}

interface Entry {
    url: string | null;
    render: "raster" | "video" | "audio" | "download";
    refs: number;
    lastUsed: number;
}

// Keep up to SOFT_CAP *released* previews for instant re-display; never evict a live one until the
// absolute HARD_CAP (which only triggers on leaked releases). Both are independent of any one
// caller.
const SOFT_CAP = 40;
const HARD_CAP = 200;

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

// A concurrency queue for full-file decryptions (a grid mounts many images at once)
const queue: (() => void)[] = [];
let activeDecrypts = 0;
const MAX_CONCURRENT_DECRYPTS = 3;

async function enterQueue() {
    if (activeDecrypts < MAX_CONCURRENT_DECRYPTS) {
        activeDecrypts++;
        return;
    }
    return new Promise<void>((resolve) => {
        queue.push(resolve);
    });
}

function leaveQueue() {
    const next = queue.shift();
    if (next) {
        next();
    } else {
        activeDecrypts--;
    }
}

// A light thumbnail cache — it stores only the inline payload.thumbnail blobs.
// Keyed by fileId; kept apart from the full-image cache so the grid cards and the detail
// panel hold their refs independently, without getting in each other's way.
interface ThumbEntry {
    url: string; // always a raster — download-only files never reach this cache
    refs: number;
    lastUsed: number;
}
const thumbCache = new Map<string, ThumbEntry>();
const thumbInflight = new Map<string, Promise<ThumbCreateResult>>();

async function createEntry(fileId: string, force = false): Promise<Entry> {
    await enterQueue();
    let result: Awaited<ReturnType<typeof decryptFile>>;
    try {
        result = await decryptFile(fileId, undefined, { forceDownload: force });
    } finally {
        leaveQueue();
    }

    const url =
        result.render === "raster"
            ? URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: result.blobMime }))
            : null;
    // Inserted with refs:0; the acquiring caller takes its ref (and runs enforceCap) below, so the
    // entry is already protected when the cap is checked — there is no evict-before-use race.
    const entry: Entry = { url, render: result.render, refs: 0, lastUsed: Date.now() };
    cache.set(fileId, entry);
    return entry;
}

/**
 * Fetches a file's preview — decrypting once, then sharing it — and takes a ref on it. Callers MUST
 * call `release(fileId)` exactly once when they stop displaying it. It rejects if the decryption
 * fails.
 *
 * `opts.force = true` skips the auto-download policy check — use it when the user
 * explicitly clicks "Download" on a placeholder. Without force, a `FileNotLocalError`
 * propagates to the caller, which shows a placeholder instead of the decrypted content.
 */
export async function acquire(
    fileId: string,
    opts?: { force?: boolean },
): Promise<AcquiredPreview> {
    let entry = cache.get(fileId);
    if (!entry) {
        if (opts?.force) {
            // An explicit download: bypass the in-flight cache so a forced request does not inherit a
            // rejected (policy-blocked) in-flight promise from an earlier non-forced call.
            entry = await createEntry(fileId, true);
        } else {
            let pending = inflight.get(fileId);
            if (!pending) {
                pending = createEntry(fileId, false);
                inflight.set(fileId, pending);
                // Clear the in-flight slot on settle. The `.catch` swallows the rejection only on THIS branch
                // (undecryptable / a 404 chunk / FileNotLocalError) so it is not an unhandled rejection;
                // the real awaiter below still sees the throw and handles it.
                pending.finally(() => inflight.delete(fileId)).catch(() => {});
            }
            entry = await pending;
        }
    }
    entry.refs++;
    entry.lastUsed = Date.now();
    enforceCap(); // safe now: this entry has refs>0, so it cannot be soft-evicted
    return { url: entry.url, render: entry.render };
}

/** Drops one ref. The entry is kept for reuse; the LRU cap frees the memory. */
export function release(fileId: string): void {
    const entry = cache.get(fileId);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
}

/** Forget one file (after a Replace that bumped the content, say). It revokes its URL at once. */
export function invalidate(fileId: string): void {
    invalidateSilent(fileId);
    // Tell every encFile NodeView holding this id to decrypt again from the new chunk set.
    // notifyFileInvalidated also broadcasts to the other tabs.
    void import("./file-invalidator").then((m) => m.notifyFileInvalidated(fileId));
}

/**
 * Like invalidate(), but it skips the cross-tab BroadcastChannel post.
 * The BroadcastChannel receiver in file-invalidator.ts calls it, to avoid echo loops.
 */
export function invalidateSilent(fileId: string): void {
    const entry = cache.get(fileId);
    if (entry) drop(fileId, entry);
    // Clear every cached thumbnail for this file too.
    const thumbEntry = thumbCache.get(fileId);
    if (thumbEntry) {
        URL.revokeObjectURL(thumbEntry.url);
        thumbCache.delete(fileId);
    }
    thumbInflight.delete(fileId);
}

/** Revoke and drop everything — call it on lock or logout so no plaintext blob outlives the session. */
export function clearBlobCache(): void {
    for (const entry of cache.values()) {
        if (entry.url) URL.revokeObjectURL(entry.url);
    }
    cache.clear();
    inflight.clear();
    for (const entry of thumbCache.values()) {
        URL.revokeObjectURL(entry.url);
    }
    thumbCache.clear();
    thumbInflight.clear();
}

// ── Thumbnail acquire / release ───────────────────────────────────────────────────────────────

interface ThumbCreateResult {
    entry: ThumbEntry | null;
    /** The declared mime from the payload — it picks the fallback path when there is no usable thumbnail. */
    mime: string | null;
}

async function createThumbEntry(fileId: string): Promise<ThumbCreateResult> {
    const payload = await getFilePayload(fileId);
    if (!payload?.thumbnail) return { entry: null, mime: payload?.mime ?? null };
    const { fromBase64 } = await import("$lib/core/utils/base64");
    const bytes = fromBase64(payload.thumbnail);
    // Derive the mime from the WebP/JPEG magic bytes rather than trusting the stored one.
    const { sniffKind } = await import("./sniff");
    const sniff = sniffKind(bytes);
    if (sniff.render !== "raster") return { entry: null, mime: payload.mime };
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: sniff.mime }));
    return { entry: { url, refs: 0, lastUsed: Date.now() }, mime: payload.mime };
}

/**
 * Like `acquire`, but it serves the inline thumbnail out of the payload instead of downloading
 * every chunk. When no thumbnail was stored, only declared `image/*` files (uploads predating the
 * thumbnail feature) fall back to the full-image `acquire` — everything else (video, audio,
 * archives…) resolves to a download-only preview with NOT ONE chunk fetched; downloading the whole
 * file only to conclude "no preview" was the anti-pattern this avoids. The sniff gate still
 * protects everything that is really rendered (the thumbnail bytes above, the full bytes in
 * `acquire`). Grid-card components should call this one; the detail panel and the editor nodes
 * should call `acquire` directly for a full-resolution view.
 */
export async function acquireThumbnail(fileId: string): Promise<AcquiredPreview> {
    // Reuse the full image if it is already cached (the detail panel was opened first, say).
    const fullEntry = cache.get(fileId);
    if (fullEntry) {
        fullEntry.refs++;
        fullEntry.lastUsed = Date.now();
        return { url: fullEntry.url, render: fullEntry.render };
    }

    let thumbEntry = thumbCache.get(fileId);
    if (!thumbEntry) {
        let pending = thumbInflight.get(fileId);
        if (!pending) {
            pending = createThumbEntry(fileId);
            thumbInflight.set(fileId, pending);
            pending.finally(() => thumbInflight.delete(fileId)).catch(() => {});
        }
        const { entry: created, mime } = await pending;
        if (!created) {
            if (isRasterImageMime(mime)) {
                // A legacy image with no thumbnail — a full decrypt is the only source of a preview.
                return acquire(fileId);
            }
            // A non-image with no thumbnail: the "download" decision needs no bytes. Callers still
            // pair this with releaseThumbnail(), which no-ops on either cache miss.
            return { url: null, render: "download" };
        }
        thumbEntry = created;
        thumbCache.set(fileId, thumbEntry);
    }

    thumbEntry.refs++;
    thumbEntry.lastUsed = Date.now();
    return { url: thumbEntry.url, render: "raster" };
}

/**
 * The paired release for `acquireThumbnail`. It decrements the ref in whichever cache was used: the
 * thumbnail cache when a thumbnail was available, otherwise the full-image cache.
 */
export function releaseThumbnail(fileId: string): void {
    const thumbEntry = thumbCache.get(fileId);
    if (thumbEntry) {
        thumbEntry.refs = Math.max(0, thumbEntry.refs - 1);
        return;
    }
    // The fallback path used the full-image cache.
    release(fileId);
}

function drop(id: string, entry: Entry): void {
    if (entry.url) URL.revokeObjectURL(entry.url);
    cache.delete(id);
}

/** Trims released entries above SOFT_CAP; force-trims the oldest of any kind above HARD_CAP. */
function enforceCap(): void {
    if (cache.size > SOFT_CAP) {
        const released = [...cache.entries()]
            .filter(([, e]) => e.refs === 0)
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed); // the oldest first
        let toRemove = cache.size - SOFT_CAP;
        for (const [id, entry] of released) {
            if (toRemove <= 0) break;
            drop(id, entry);
            toRemove--;
        }
    }
    if (cache.size > HARD_CAP) {
        const ordered = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        for (const [id, entry] of ordered) {
            if (cache.size <= HARD_CAP) break;
            drop(id, entry); // leaked release suspected — evict regardless of refs
        }
    }
}

export function getBlobCacheDevStats(): {
    entries: number;
    liveRefs: number;
    softCap: number;
    hardCap: number;
    inflight: number;
    thumbEntries: number;
    activeDecrypts: number;
    queueLength: number;
} {
    let liveRefs = 0;
    for (const entry of cache.values()) {
        if (entry.refs > 0) liveRefs++;
    }
    return {
        entries: cache.size,
        liveRefs,
        softCap: SOFT_CAP,
        hardCap: HARD_CAP,
        inflight: inflight.size,
        thumbEntries: thumbCache.size,
        activeDecrypts,
        queueLength: queue.length,
    };
}

export function getBlobCacheEntryStats(fileId: string): { refs: number; render: string } | null {
    const entry = cache.get(fileId);
    if (!entry) return null;
    return { refs: entry.refs, render: entry.render };
}
