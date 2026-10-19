// The streaming output for exports. Where the browser supports the File System Access API
// (showSaveFilePicker) we write frame by frame straight to disk → constant memory even for vaults
// over a GB. Otherwise it falls back to an in-memory blob download (Firefox/Safari) — the same
// ceiling as before, but only there
// where streaming is unavailable. ZipStreamWriter builds the ZIP incrementally (fflate's streaming Zip),
// while encryptedSink passes the bytes through BackupEncryptor before writing.

import {
    type ByteSink,
    openFilePickerSink,
    triggerAnchorDownload,
} from "$lib/core/utils/download-sink";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import type { BackupEncryptor } from "./backup-crypto";

/** The user cancelled the "Save as" dialog — treat it as an abort, not an error. */
export class BackupAbortedError extends Error {
    constructor() {
        super("Backup cancelled");
        this.name = "BackupAbortedError";
    }
}

/** An abstraction over a sink of bytes: either an FS Access writable stream or an in-memory blob. */
export type BackupSink = ByteSink;

function triggerBlobDownload(chunks: Uint8Array[], filename: string, mime: string): void {
    const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mime }));
    triggerAnchorDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

const tryFilePickerSink = (filename: string, accept: Record<string, string[]>) =>
    openFilePickerSink(filename, { accept, onAbort: () => new BackupAbortedError() });

function blobSink(filename: string, mime: string): BackupSink {
    const chunks: Uint8Array[] = [];
    return {
        write: async (bytes) => {
            chunks.push(bytes);
        },
        close: async () => {
            triggerBlobDownload(chunks, filename, mime);
        },
        abort: async () => {
            chunks.length = 0;
        },
    };
}

/**
 * Opens the output sink: it tries the FS Access "Save as" (streaming to disk), otherwise an
 * in-memory blob. It throws BackupAbortedError if the user cancels the dialog.
 */
export async function createBackupSink(
    filename: string,
    mime: string,
    accept: Record<string, string[]>,
): Promise<BackupSink> {
    const picker = await tryFilePickerSink(filename, accept);
    return picker ?? blobSink(filename, mime);
}

/**
 * An in-memory sink for the tests and for a programmatic export (with no dialog and no download).
 * `bytes()` returns every byte written so far (after `close` that is the finished ZIP/cnbackup).
 */
export function createMemorySink(): { sink: BackupSink; bytes: () => Uint8Array } {
    const chunks: Uint8Array[] = [];
    return {
        sink: {
            write: async (b) => {
                // A copy — the caller (ZipStreamWriter) may recycle the buffer.
                chunks.push(b.slice());
            },
            close: async () => {},
            abort: async () => {
                chunks.length = 0;
            },
        },
        bytes: () => {
            let total = 0;
            for (const c of chunks) total += c.length;
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
                out.set(c, off);
                off += c.length;
            }
            return out;
        },
    };
}

/** Wraps a sink in encryption: every write goes through BackupEncryptor, and close flushes the final frame. */
export function encryptedSink(inner: BackupSink, encryptor: BackupEncryptor): BackupSink {
    return {
        write: async (bytes) => {
            const out = encryptor.push(bytes);
            if (out.length) await inner.write(out);
        },
        close: async () => {
            await inner.write(encryptor.finish());
            await inner.close();
        },
        abort: (reason) => inner.abort(reason),
    };
}

/**
 * An incremental ZIP writer over a sink. It adds one entry at a time (deflate for text, store for
 * already-compressed binary files) and flushes ZIP bytes into the sink as soon as fflate produces
 * them. The writes are serialised through writeChain, so addFile and finish return only once the sink
 * has drained — which keeps peak memory at roughly one item instead of the whole vault.
 */
export class ZipStreamWriter {
    private readonly zip: Zip;
    private writeChain: Promise<void> = Promise.resolve();
    private failure: unknown = null;

    constructor(private readonly sink: BackupSink) {
        this.zip = new Zip((err, chunk, _final) => {
            if (err) {
                this.failure ??= err;
                return;
            }
            if (chunk.length > 0) {
                // fflate may recycle its output buffer after ondata; the write and the encryption run
                // asynchronously (writeChain / the encryptor's buffering), so we have to copy into our
                // own ownership.
                const owned = chunk.slice();
                this.writeChain = this.writeChain.then(() => this.sink.write(owned));
            }
        });
    }

    /** Adds an item. `compress=false` (store) for already-compressed binary files (images, video…). */
    async addFile(path: string, data: Uint8Array, compress: boolean): Promise<void> {
        if (this.failure) throw this.failure;
        const entry = compress ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
        this.zip.add(entry);
        entry.push(data, true);
        await this.drain();
    }

    async finish(): Promise<void> {
        this.zip.end();
        await this.drain();
    }

    private async drain(): Promise<void> {
        await this.writeChain;
        if (this.failure) throw this.failure;
    }
}
