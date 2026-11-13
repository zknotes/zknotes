// An incremental ZIP writer over a byte sink (fflate's streaming Zip). It lives in core because more
// than one module writes ZIPs (the backup/export, the seal certificate) and modules may not import
// each other.

import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import type { ByteSink } from "./download-sink";

/**
 * Adds one entry at a time (deflate for text, store for already-compressed binary files) and
 * flushes ZIP bytes into the sink as soon as fflate produces them. The writes are serialised through
 * writeChain, so addFile, addStream and finish return only once the sink has drained — which keeps
 * peak memory at roughly one item (or one chunk of a streamed item) instead of the whole archive.
 */
export class ZipStreamWriter {
    private readonly zip: Zip;
    private writeChain: Promise<void> = Promise.resolve();
    private failure: unknown = null;

    constructor(private readonly sink: ByteSink) {
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

    /**
     * Adds an item from a sequence of pieces, draining after each one, so a large file passes
     * through without ever being held whole.
     */
    async addStream(
        path: string,
        pieces: AsyncIterable<Uint8Array>,
        compress: boolean,
    ): Promise<void> {
        if (this.failure) throw this.failure;
        const entry = compress ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
        this.zip.add(entry);
        for await (const piece of pieces) {
            entry.push(piece, false);
            await this.drain();
        }
        entry.push(new Uint8Array(0), true);
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
