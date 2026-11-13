// The streaming output for exports. Where the browser supports the File System Access API
// (showSaveFilePicker) we write frame by frame straight to disk → constant memory even for vaults
// over a GB. Otherwise it falls back to an in-memory blob download (Firefox/Safari) — the same
// ceiling as before, but only there
// where streaming is unavailable. The ZIP itself is built by core's ZipStreamWriter
// (`core/utils/zip-stream`), while encryptedSink passes the bytes through BackupEncryptor before
// writing.

import { blobDownloadSink, type ByteSink, openFilePickerSink } from "$lib/core/utils/download-sink";
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

const tryFilePickerSink = (filename: string, accept: Record<string, string[]>) =>
    openFilePickerSink(filename, { accept, onAbort: () => new BackupAbortedError() });

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
    return picker ?? blobDownloadSink(filename, mime);
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
