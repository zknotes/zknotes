/**
 * The main-thread side of the video/audio stream protocol:
 * the service worker intercepts the `/zknotes/stream/<fileId>` fetch and asks the main thread — the
 * only one with access to the crypto worker — for a decrypted ReadableStream.
 *
 * The message types are shared with service-worker.ts — the protocol changes in one place.
 */
import { fileBridge } from "$lib/core/events/file-bridge";

// ── The message types (SW ↔ the main thread) ─────────────────────────────────

/** SW → main: a request for a stream; the answer goes back through a MessageChannel port. */
export interface RequestStreamMessage {
    type: "REQUEST_STREAM";
    fileId: string;
    /** The dedup key — the SW retries the postMessage every 500 ms until the main thread answers. */
    reqId: string;
    headers: Record<string, string>;
}

/** main → SW: the stream is ready (it is transferred through the port). */
export interface StreamReadyMessage {
    type: "STREAM_READY";
    stream: ReadableStream<Uint8Array>;
    mime: string;
    /** The file's total plaintext size (Content-Length / the Content-Range total). */
    size: number;
    /** Present for a partial response (HTTP 206) — an inclusive byte range. */
    range?: { start: number; end: number };
}

/** main → SW: the decryption/fetch failed. */
export interface StreamErrorMessage {
    type: "STREAM_ERROR";
    error: string;
    /** The HTTP status for the SW's answer (500 by default); 416 for an unsatisfiable Range. */
    status?: number;
    /** With a 416 — the file's total size for the Content-Range header. */
    totalSize?: number;
}

export type StreamResponseMessage = StreamReadyMessage | StreamErrorMessage;

// ── Main-thread bridge ────────────────────────────────────────────────────────

const pendingStreams = new Set<string>();

/** Idempotent — the (app) layout's instance script can re-run on a remount. */
let streamBridgeInitialized = false;

/**
 * Registers the service worker and the message handler that serves decrypted streams.
 * A no-op outside the browser, or without SW support. Call it once from the (app) layout.
 */
export function initStreamBridge(): void {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (streamBridgeInitialized) return;
    streamBridgeInitialized = true;

    navigator.serviceWorker.register("/service-worker.js", { type: "module" }).catch((e) => {
        console.warn("Service worker registration failed", e);
    });

    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "REQUEST_STREAM") {
            const port = event.ports[0];
            if (!port) return;
            void handleStreamRequest(event.data as RequestStreamMessage, port);
        }
    });
}

/**
 * Video and audio players use `/zknotes/stream/<id>`, which **only** the SW intercepts.
 * With no active controller the fetch falls through to a Vite/Caddy 404 → a media error → a file chip.
 * Wait for ready plus claim before setting media.src (which matters most right after an upload).
 */
export async function ensureStreamServiceWorker(timeoutMs = 8_000): Promise<boolean> {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
    try {
        const reg = await navigator.serviceWorker.register("/service-worker.js", {
            type: "module",
        });
        // An active controller is enough for /zknotes/stream/ to be intercepted — do NOT activate a
        // waiting worker. SKIP_WAITING used to be sent unconditionally, so playing a video in the
        // middle of a session activated a background update → controllerchange → a hard reload.
        // A background update still waits for the user's "Reload" from the toast.
        if (navigator.serviceWorker.controller) return true;
        // With no controller, forcing it is the only way: a waiting worker otherwise takes control
        // only once every tab is closed, and until then the stream answers 404.
        if (reg.waiting) {
            reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
        await navigator.serviceWorker.ready;
        if (navigator.serviceWorker.controller) return true;

        await new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                navigator.serviceWorker.removeEventListener("controllerchange", onChange);
                resolve();
            };
            const onChange = () => done();
            const timer = setTimeout(done, timeoutMs);
            navigator.serviceWorker.addEventListener("controllerchange", onChange);
            // Repeat skipWaiting if the worker moved into waiting meanwhile.
            if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
            // installing → wait for activate
            reg.installing?.addEventListener("statechange", () => {
                if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
            });
        });
        return !!navigator.serviceWorker.controller;
    } catch (e) {
        console.warn("Stream service worker not available", e);
        return false;
    }
}

/**
 * Parses a single-range `Range` header (inclusive bounds, per RFC 9110).
 * - `null` → serve the whole file (no header, a multi-range, or an unrecognised form — by the
 *   specification the server MAY ignore Range and answer 200).
 * - `"unsatisfiable"` → HTTP 416.
 *
 * An exported test seam — see sw-bridge.test.ts.
 */
export function parseRangeHeader(
    header: string | undefined,
    size: number,
): { start: number; end: number } | null | "unsatisfiable" {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return null;
    const [, rawStart = "", rawEnd = ""] = m;
    if (rawStart === "" && rawEnd === "") return null;
    if (rawStart === "") {
        // The suffix form: the last N bytes ("bytes=-500", say).
        const n = Number(rawEnd);
        if (n === 0 || size === 0) return "unsatisfiable";
        return { start: Math.max(0, size - n), end: size - 1 };
    }
    const start = Number(rawStart);
    if (start >= size) return "unsatisfiable";
    const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (end < start) return "unsatisfiable";
    return { start, end };
}

/** Answers one REQUEST_STREAM from the SW. An exported test seam — see sw-bridge.test.ts. */
export async function handleStreamRequest(
    msg: RequestStreamMessage,
    port: MessagePort,
): Promise<void> {
    const { fileId, reqId } = msg;

    // The SW sends the same request every 500 ms until it gets an answer — ignore the duplicates.
    if (pendingStreams.has(reqId)) return;
    pendingStreams.add(reqId);
    setTimeout(() => pendingStreams.delete(reqId), 5000);

    try {
        const { devLog } = await import("$lib/core/utils/dev-log");
        devLog("stream", `Main thread accepted stream request: ${reqId} for file ${fileId}`);

        const payload = await fileBridge.getFilePayload(fileId);
        if (!payload) {
            devLog("stream", `File payload not found for ${fileId}`);
            throw new Error("File payload not found");
        }

        const { chunkSetId, chunks, size } = payload;
        const totalChunks = chunks.length;
        // Older uploads predate the `chunkSize` field — all of them used the same constant.
        const { FILE_LIMITS } = await import("@zknotes/shared");
        const chunkSize = payload.chunkSize || FILE_LIMITS.CHUNK_SIZE;

        // Prefer the sniff for the Content-Type (do not trust the user's MIME for a render
        // decision). Fall back to payload.mime for video and audio — otherwise an unknown ftyp
        // brand → octet-stream and the browser kills the <video> (MEDIA_ERR_SRC_NOT_SUPPORTED) even
        // though the bytes are a valid MP4.
        let streamMime = "application/octet-stream";
        try {
            const { peekSniffFile } = await import("$lib/modules/files/download");
            const sniff = await peekSniffFile(fileId, { forceDownload: true });
            if (sniff.render === "video" || sniff.render === "audio") {
                streamMime = sniff.mime;
            }
        } catch {
            // a network/sniff failure — the payload fallback below
        }
        if (
            streamMime === "application/octet-stream" &&
            typeof payload.mime === "string" &&
            (payload.mime.startsWith("video/") || payload.mime.startsWith("audio/"))
        ) {
            streamMime = payload.mime;
        }

        const range = parseRangeHeader(msg.headers.range, size);
        if (range === "unsatisfiable") {
            devLog(
                "stream",
                `Unsatisfiable range "${msg.headers.range}" for ${fileId} (size ${size})`,
            );
            const err: StreamErrorMessage = {
                type: "STREAM_ERROR",
                error: "Range Not Satisfiable",
                status: 416,
                totalSize: size,
            };
            port.postMessage(err);
            return;
        }

        const start = range?.start ?? 0;
        const end = range?.end ?? size - 1;
        const startChunk = Math.floor(start / chunkSize);
        const endChunk = Math.min(Math.floor(end / chunkSize), totalChunks - 1);

        devLog(
            "stream",
            `Starting ReadableStream for ${fileId} (bytes ${start}-${end}, chunks ${startChunk}-${endChunk} of ${totalChunks})`,
        );

        const { loadChunk } = await import("$lib/core/files/chunk-loader");
        const { decryptChunkTask } = await import("$lib/core/workers/crypto-rpc");
        const { fromBase64 } = await import("$lib/core/utils/base64");

        // Pull-based: one chunk per pull() call, so backpressure works and aborting the browser's
        // request (a cancel) stops any further fetching — a metadata probe no longer costs the whole file.
        let nextChunk = startChunk;
        // cancel() can arrive while pull() awaits a fetch or decryption — an enqueue onto a closed
        // stream throws a TypeError, so an in-flight pull has to give up rather than enqueue.
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const i = nextChunk++;
                    const nonce = fromBase64(chunks[i]?.nonce);
                    // Read-through: the local cache → the network plus persistence (every chunk
                    // watched stays available offline, not only pinned ones — a pin merely protects
                    // against LRU eviction, see chunk-loader.ts::enforceCap).
                    const ciphertext = await loadChunk(chunkSetId, i, nonce);
                    const plain = await decryptChunkTask(
                        fileId,
                        chunkSetId,
                        i,
                        totalChunks,
                        ciphertext,
                        nonce,
                    );
                    if (cancelled) return;
                    // The edge chunks are cut down to the requested range; slice rather than subarray,
                    // because a structured clone on transfer into the SW would otherwise copy the whole
                    // underlying buffer.
                    const base = i * chunkSize;
                    const lo = Math.max(0, start - base);
                    const hi = Math.min(plain.byteLength, end + 1 - base);
                    controller.enqueue(
                        lo === 0 && hi === plain.byteLength ? plain : plain.slice(lo, hi),
                    );
                    if (i >= endChunk) {
                        controller.close();
                        devLog(
                            "stream",
                            `Stream finished for ${reqId} (chunks ${startChunk}-${endChunk})`,
                        );
                    }
                } catch (e) {
                    if (cancelled) return;
                    devLog("stream", `Stream chunk reading error for ${reqId}`, e);
                    controller.error(e);
                }
            },
            cancel(reason) {
                cancelled = true;
                devLog("stream", `Stream cancelled by consumer for ${reqId}`, reason);
            },
        });
        const ready: StreamReadyMessage = {
            type: "STREAM_READY",
            stream,
            mime: streamMime,
            size,
            ...(range ? { range } : {}),
        };
        port.postMessage(ready, [stream as unknown as Transferable]);
    } catch (e) {
        const err: StreamErrorMessage = {
            type: "STREAM_ERROR",
            error: e instanceof Error ? e.message : "Unknown error",
        };
        port.postMessage(err);
    }
}
