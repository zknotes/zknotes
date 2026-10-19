// The download and preview pipeline: fetch each ciphertext chunk, decrypt it in the worker (the AAD
// binds chunkSetId plus the position), assemble the plaintext and wrap it in a Blob whose type is
// chosen by SNIFFING the bytes — never from the declared MIME.
import {
    type ByteSink,
    openFilePickerSink,
    triggerAnchorDownload,
} from "$lib/core/utils/download-sink";
import type { FilePayload } from "@zknotes/shared";
import { getDB } from "$lib/core/db";
import { loadChunk } from "$lib/core/files/chunk-loader";
import { fromBase64 } from "$lib/core/utils/base64";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";
import { decryptChunkTask } from "$lib/core/workers/crypto-rpc";
import { emitFilesChanged } from "./files-changed-bus";
import { sniffKind } from "./sniff";

export interface DecryptedFile {
    /** The assembled plaintext, ready for a Blob. */
    bytes: Uint8Array;
    /** The name/MIME declared in the encrypted payload (for display only — not a render decision). */
    name: string;
    declaredMime: string;
    /** The render decision, derived from the real bytes. */
    render: "raster" | "video" | "audio" | "download";
    /** The Blob's MIME — sniffed for a raster image, otherwise octet-stream. */
    blobMime: string;
}

export interface DownloadProgress {
    chunkIndex: number;
    totalChunks: number;
}

/**
 * Thrown when a file cannot be loaded because it is not READY:
 * - `"trashed"` — the row exists with `deleted_at` set (in Trash, RESTORABLE → the embed shows "in
 *   trash").
 * - `"gone"` — there is no row (permanently purged, or not pulled yet → "unavailable/deleted").
 */
export class FileDeletedError extends Error {
    constructor(
        public readonly fileId: string,
        public readonly reason: "trashed" | "gone" = "gone",
    ) {
        super(`File ${fileId} is ${reason}`);
        this.name = "FileDeletedError";
    }
}

/**
 * Thrown when the auto-download policy blocks fetching a file that is not cached. Callers catch
 * this error and show a placeholder with a "Download" button.
 */
export class FileNotLocalError extends Error {
    constructor(
        public readonly fileId: string,
        public readonly sizeBytes: number,
    ) {
        super(`File ${fileId} is not downloaded locally (${sizeBytes} bytes)`);
        this.name = "FileNotLocalError";
    }
}

/**
 * Decrypts only a file's metadata payload, without downloading any chunk. It uses the thumbnail
 * cache to read `payload.thumbnail` without touching the network. It returns null on any error so
 * callers
 * can fall back gracefully (to a full-image decrypt, for instance).
 */
export async function getFilePayload(itemId: string): Promise<FilePayload | null> {
    try {
        return await loadFilePayload(itemId);
    } catch {
        return null;
    }
}

async function loadFilePayload(itemId: string): Promise<FilePayload> {
    const db = await getDB();
    const item = await db.get("items", itemId);
    if (!item) throw new FileDeletedError(itemId, "gone");
    // FileLifecycle derives the state (the only source): READY loads; TRASHED and DELETED → a placeholder.
    // The NodeView picks the message from the reason; what matters is that the node is NOT removed, so a restore brings the file back into the note.
    const state = FileLifecycle.stateOf(item);
    if (state !== "READY") {
        throw new FileDeletedError(itemId, state === "TRASHED" ? "trashed" : "gone");
    }

    const { decryptItemPayload } = await import("$lib/core/crypto/item-codec");
    const payload = await decryptItemPayload<FilePayload>(item);
    if (payload.kind !== "file" || !payload.chunkSetId) {
        throw new Error("Item is not a file");
    }
    return payload;
}

/**
 * Decrypts only a file's first chunk to determine its real type from the magic bytes.
 * This gives a fast "peek" at large files without pulling the whole content into memory.
 */
export async function peekSniffFile(
    itemId: string,
    opts?: { forceDownload?: boolean },
): Promise<import("./sniff").SniffedKind> {
    const payload = await loadFilePayload(itemId);
    const { chunkSetId, chunks } = payload;
    const totalChunks = chunks.length;

    if (!opts?.forceDownload) {
        const { hasAllChunks } = await import("$lib/core/db/file-chunks");
        const isLocal = await hasAllChunks(chunkSetId, totalChunks);
        if (!isLocal) {
            const { shouldAutoDownload } = await import("$lib/modules/files/sync-settings");
            if (!shouldAutoDownload(payload.size)) {
                throw new FileNotLocalError(itemId, payload.size);
            }
        }
    }

    if (totalChunks === 0) return { render: "download", mime: "application/octet-stream" };

    const nonce = fromBase64(chunks[0].nonce);
    const ciphertext = await loadChunk(chunkSetId, 0, nonce);
    const plain = await decryptChunkTask(itemId, chunkSetId, 0, totalChunks, ciphertext, nonce);
    // Chunk 0 is now cached; for a single-chunk file that means "every chunk is local" → refresh the
    // presence badge. For a multi-chunk file the badge stays ☁️, because hasAllChunks returns false.
    emitFilesChanged([itemId]);
    return sniffKind(plain);
}

/**
 * Decrypts the whole file and returns the plaintext bytes plus the sniff-based render decision.
 * `onProgress` is emitted per chunk, so callers can show a progress bar for large downloads.
 *
 * The `forceDownload: true` option skips the policy check — it is used when the user explicitly
 * clicks "Download" on a placeholder that is blocking the automatic fetch.
 *
 * The `persist: false` option (`true` by default) is ONLY for one-shot reads (an export or a
 * backup) that must not fill or evict the offline cache. Normal viewing (an encFile preview, an
 * inline render) MUST persist whether or not the file is pinned — a pin is only a signal to the
 * EVICTION (`chunk-loader.ts::enforceCap`) that it must not evict that set — not a gate on writing
 * to the cache at all. `isPinnedChunkSet` used to be wrongly used here as the condition for
 * persisting, so after a reload with the network blocked every UNpinned file — the vast majority —
 * lost the "I saw it once → it is available offline" guarantee (caught by E2E:
 * `18-file-offline-read.spec.ts`).
 */
export async function decryptFile(
    itemId: string,
    onProgress?: (p: DownloadProgress) => void,
    opts?: { forceDownload?: boolean; persist?: boolean },
): Promise<DecryptedFile> {
    const payload = await loadFilePayload(itemId);
    const { chunkSetId, chunks } = payload;
    const totalChunks = chunks.length;

    // The policy check: if the file is not local and the policy forbids auto-downloading, throw
    // FileNotLocalError so the caller shows a placeholder with a "Download" button.
    if (!opts?.forceDownload) {
        const { hasAllChunks } = await import("$lib/core/db/file-chunks");
        const isLocal = await hasAllChunks(chunkSetId, totalChunks);
        if (!isLocal) {
            const { shouldAutoDownload } = await import("$lib/modules/files/sync-settings");
            if (!shouldAutoDownload(payload.size)) {
                throw new FileNotLocalError(itemId, payload.size);
            }
        }
    }

    const persist = opts?.persist !== false;

    const parts: Uint8Array[] = [];
    let totalLen = 0;
    for (let i = 0; i < totalChunks; i++) {
        onProgress?.({ chunkIndex: i, totalChunks });
        const nonce = fromBase64(chunks[i].nonce);
        // Read-through + the hash verify (the manifest's SHA-256 of the ciphertext).
        const ciphertext = await loadChunk(chunkSetId, i, nonce, chunks[i].hash, { persist });
        // decryptChunkTask transfers (detaches) ciphertext.buffer — fine, loadChunk returns a fresh buffer.
        const plain = await decryptChunkTask(itemId, chunkSetId, i, totalChunks, ciphertext, nonce);
        parts.push(plain);
        totalLen += plain.byteLength;
    }

    const bytes = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) {
        bytes.set(p, off);
        off += p.byteLength;
    }

    // Every chunk is fetched and cached → refresh the presence badge.
    emitFilesChanged([itemId]);

    const sniff = sniffKind(bytes);
    let blobMime = "application/octet-stream";

    if (sniff.render === "raster" || sniff.render === "svg") {
        blobMime = sniff.mime;
    }

    return {
        bytes,
        name: payload.name,
        declaredMime: payload.mime,
        // An SVG stays a download chip — remapping it to a raster turned a vector into an unbounded
        // <img> and mutated the bytes through DOMPurify (a backup or export would get a sanitised
        // SVG instead of the original).
        render: sniff.render === "svg" ? "download" : sniff.render,
        blobMime,
    };
}

/**
 * The user cancelled the "Save as" dialog (File System Access). Callers do not show this
 * as an error — it is a silent abort.
 */
export class DownloadCancelledError extends Error {
    constructor() {
        super("Download cancelled");
        this.name = "DownloadCancelledError";
    }
}

/**
 * The upper bound on an in-memory blob download (Firefox/Safari without FS Access / OPFS).
 * Above it → streaming to disk (Save as / OPFS); 2 GB into a single Uint8Array = an OOM and "nothing happens".
 */
const MEMORY_DOWNLOAD_MAX_BYTES =
    (Number(import.meta.env.VITE_FILE_MEMORY_DOWNLOAD_MAX_MB) || 100) * 1024 * 1024;

type DownloadSink = ByteSink;

/** The File System Access "Save as" — it streams chunk by chunk to disk (Chrome/Edge). */
const tryFilePickerSink = (filename: string) =>
    openFilePickerSink(filename, { onAbort: () => new DownloadCancelledError() });

const OPFS_DOWNLOADS_DIR = "downloads";

/**
 * Temp files a download is still using: being written, or already handed to the browser as a blob
 * URL that it may still be reading (the 60 s revoke delay below exists for multi-GB saves). The
 * unload/visibility sweep must not delete these — switching tabs mid-download would otherwise pull
 * the file out from under the save. Startup and logout sweep unconditionally: nothing is in flight.
 */
const activeDownloadTemps = new Set<string>();

/**
 * Removes leftover plaintext download temps: everything under OPFS `downloads/`, plus legacy
 * `dl-*.part` files in the OPFS root (written by older clients that never cleaned up).
 *
 * `keepActive` spares the temps in `activeDownloadTemps` — for the sweep that runs while the page
 * is still alive (tab hidden / pagehide). Without it the whole directory goes.
 */
export async function cleanupOpfsDownloadTemps(opts?: { keepActive?: boolean }): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return;
    let root: FileSystemDirectoryHandle;
    try {
        root = await navigator.storage.getDirectory();
    } catch {
        return;
    }
    const keep = opts?.keepActive && activeDownloadTemps.size > 0;
    if (keep) {
        try {
            const dir = await root.getDirectoryHandle(OPFS_DOWNLOADS_DIR, { create: false });
            for await (const [name] of (
                dir as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }
            ).entries()) {
                if (activeDownloadTemps.has(name)) continue;
                await dir.removeEntry(name, { recursive: true }).catch(() => {});
            }
        } catch {
            // missing — fine
        }
    } else {
        try {
            await root.removeEntry(OPFS_DOWNLOADS_DIR, { recursive: true });
        } catch {
            // missing — fine
        }
    }
    try {
        for await (const [name, entry] of (
            root as unknown as {
                entries: () => AsyncIterable<[string, FileSystemHandle]>;
            }
        ).entries()) {
            if (entry.kind === "file" && /^dl-.*\.part$/.test(name)) {
                await root.removeEntry(name).catch(() => {});
            }
        }
    } catch {
        // best-effort
    }
}

function attachDownloadTempUnloadSweep(): void {
    if (typeof window === "undefined" || attachDownloadTempUnloadSweep.done) return;
    attachDownloadTempUnloadSweep.done = true;
    const sweep = () => {
        void cleanupOpfsDownloadTemps({ keepActive: true });
    };
    window.addEventListener("pagehide", sweep);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") sweep();
    });
}
attachDownloadTempUnloadSweep.done = false;

/**
 * OPFS temp file → object URL download (Firefox/Safari path without Save-as).
 * It does not hold the whole plaintext in the JS heap as one Uint8Array.
 */
async function tryOpfsDownloadSink(filename: string): Promise<DownloadSink | null> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
    attachDownloadTempUnloadSweep();
    let root: FileSystemDirectoryHandle;
    try {
        root = await navigator.storage.getDirectory();
    } catch {
        return null;
    }
    let dir: FileSystemDirectoryHandle;
    try {
        dir = await root.getDirectoryHandle(OPFS_DOWNLOADS_DIR, { create: true });
    } catch {
        return null;
    }
    const tmpName = `dl-${crypto.randomUUID()}.part`;
    let fh: FileSystemFileHandle;
    let writable: FileSystemWritableFileStream;
    try {
        fh = await dir.getFileHandle(tmpName, { create: true });
        writable = await fh.createWritable();
    } catch {
        return null;
    }
    activeDownloadTemps.add(tmpName);
    const cleanup = async () => {
        activeDownloadTemps.delete(tmpName);
        try {
            await dir.removeEntry(tmpName);
        } catch {
            // best-effort
        }
    };
    return {
        write: async (bytes) => {
            await writable.write(bytes as BufferSource);
        },
        close: async () => {
            await writable.close();
            try {
                const file = await fh.getFile();
                const url = URL.createObjectURL(file);
                try {
                    triggerAnchorDownload(url, filename);
                } finally {
                    // A longer delay — a large OPFS download must not revoke before the browser
                    // gets to start the save (a setTimeout of 0 is too short for multi-GB).
                    setTimeout(() => {
                        URL.revokeObjectURL(url);
                        void cleanup();
                    }, 60_000);
                }
            } catch (e) {
                await cleanup();
                throw e;
            }
        },
        abort: async () => {
            try {
                await writable.abort();
            } catch {
                // already closed
            }
            await cleanup();
        },
    };
}

function memoryBlobSink(filename: string, maxBytes: number): DownloadSink {
    const parts: Uint8Array[] = [];
    let total = 0;
    return {
        write: async (bytes) => {
            total += bytes.byteLength;
            if (total > maxBytes) {
                throw new Error(
                    `File is too large to download in this browser without disk streaming ` +
                        `(>${Math.floor(maxBytes / (1024 * 1024))} MB). Try Chrome/Edge, or export from a desktop browser.`,
                );
            }
            // A copy — the decrypt buffers can be recycled or detached.
            parts.push(bytes.slice());
        },
        close: async () => {
            const url = URL.createObjectURL(
                new Blob(parts as BlobPart[], { type: "application/octet-stream" }),
            );
            try {
                triggerAnchorDownload(url, filename);
            } finally {
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
            }
        },
        abort: async () => {
            parts.length = 0;
        },
    };
}

/**
 * Opens the output sink for a user download:
 * 1) Save as (FS Access)  2) OPFS temp + anchor  3) an in-memory blob (only below the cap).
 *
 * Important: call it as close to the user gesture (the click) as possible — showSaveFilePicker requires transient activation.
 */
async function openDownloadSink(filename: string, plainSize: number): Promise<DownloadSink> {
    const picker = await tryFilePickerSink(filename);
    if (picker) return picker;
    const opfs = await tryOpfsDownloadSink(filename);
    if (opfs) return opfs;
    if (plainSize > MEMORY_DOWNLOAD_MAX_BYTES) {
        throw new Error(
            `This file is too large to download in-memory (${Math.ceil(plainSize / (1024 * 1024))} MB). ` +
                "Use Chrome or Edge for large file downloads, or free up browser storage.",
        );
    }
    return memoryBlobSink(filename, MEMORY_DOWNLOAD_MAX_BYTES);
}

/**
 * How many chunks to fetch and decrypt ahead while the current one is written to disk.
 * It overlaps network and crypto with disk I/O; too large a window means peak RAM (~N × 5 MiB of
 * plaintext).
 */
const SAVE_PREFETCH = 3;

/**
 * A user-initiated "Save as": it streams the decrypted chunks to disk (or OPFS) without assembling
 * the whole file in RAM. It skips the auto-download policy (an explicit click = force).
 *
 * It throws {@link DownloadCancelledError} if the user closes the Save-as dialog.
 */
export async function saveFile(
    itemId: string,
    onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
    const payload = await loadFilePayload(itemId);
    const { chunkSetId, chunks, size } = payload;
    const totalChunks = chunks.length;
    const filename = payload.name || "download";

    // The sink BEFORE the loop — the FS picker needs a user gesture, and the meta decrypt is fast enough.
    const sink = await openDownloadSink(filename, size);

    /** Fetch and decrypt one chunk. `persist: false` — a download is neither a pin nor an offline cache. */
    const decryptAt = async (i: number): Promise<Uint8Array> => {
        const nonce = fromBase64(chunks[i]!.nonce);
        const ciphertext = await loadChunk(chunkSetId, i, nonce, chunks[i]!.hash, {
            persist: false,
        });
        return decryptChunkTask(itemId, chunkSetId, i, totalChunks, ciphertext, nonce);
    };

    try {
        // The pipeline: while chunk i is being written, i+1 … i+PREFETCH are prepared in the background.
        const inflight: Promise<Uint8Array>[] = [];
        for (let i = 0; i < Math.min(SAVE_PREFETCH, totalChunks); i++) {
            inflight.push(decryptAt(i));
        }

        for (let i = 0; i < totalChunks; i++) {
            onProgress?.({ chunkIndex: i, totalChunks });
            const plain = await inflight.shift()!;
            const next = i + SAVE_PREFETCH;
            if (next < totalChunks) {
                inflight.push(decryptAt(next));
            }
            await sink.write(plain);
        }
        await sink.close();
        // No emitFilesChanged — the chunks are not in the local cache (persist:false); the badge has
        // to stay "on the network" until the user explicitly pins it, or an auto-download pulls it.
    } catch (e) {
        await sink.abort(e).catch(() => {});
        throw e;
    }
}
