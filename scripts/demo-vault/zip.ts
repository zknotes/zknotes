/**
 * A minimal ZIP writer, so the demo-vault generator needs no dependency at all.
 *
 * `scripts/` is outside the workspaces, so nothing from `client/node_modules` (fflate, uuidv7)
 * resolves here. Everything below is `node:zlib` plus a few dozen lines of container format.
 *
 * Only what parseBackupZip needs is implemented: one central directory, no ZIP64, no data
 * descriptors, store or raw deflate per entry.
 */

import { crc32, deflateRawSync } from "node:zlib";

const encoder = new TextEncoder();

interface Entry {
    name: Uint8Array;
    crc: number;
    compressed: Uint8Array;
    method: number;
    rawSize: number;
    offset: number;
}

class ByteWriter {
    #chunks: Uint8Array[] = [];
    #length = 0;

    get length(): number {
        return this.#length;
    }

    push(bytes: Uint8Array): void {
        this.#chunks.push(bytes);
        this.#length += bytes.byteLength;
    }

    u16(value: number): void {
        this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
    }

    u32(value: number): void {
        this.push(
            new Uint8Array([
                value & 0xff,
                (value >>> 8) & 0xff,
                (value >>> 16) & 0xff,
                (value >>> 24) & 0xff,
            ]),
        );
    }

    concat(): Uint8Array {
        const out = new Uint8Array(this.#length);
        let at = 0;
        for (const chunk of this.#chunks) {
            out.set(chunk, at);
            at += chunk.byteLength;
        }
        return out;
    }
}

export class ZipBuilder {
    #entries: Entry[] = [];
    #body = new ByteWriter();

    /**
     * `compress: false` for bytes that are already compressed (a PNG) — deflating those only costs
     * time and grows the entry.
     */
    add(path: string, data: Uint8Array | string, compress = true): void {
        const raw = typeof data === "string" ? encoder.encode(data) : data;
        const deflated = compress && raw.byteLength > 0 ? deflateRawSync(raw, { level: 9 }) : null;
        const useDeflate = deflated !== null && deflated.byteLength < raw.byteLength;
        const payload = useDeflate ? new Uint8Array(deflated) : raw;
        const entry: Entry = {
            name: encoder.encode(path),
            crc: crc32(raw) >>> 0,
            compressed: payload,
            method: useDeflate ? 8 : 0,
            rawSize: raw.byteLength,
            offset: this.#body.length,
        };
        this.#entries.push(entry);

        this.#body.u32(0x04034b50); // local file header
        this.#body.u16(20); // version needed
        this.#body.u16(0x0800); // UTF-8 names
        this.#body.u16(entry.method);
        this.#body.u16(0); // modification time — a fixed 00:00 keeps the output reproducible
        this.#body.u16(0x21); // modification date — 1980-01-01, the ZIP epoch
        this.#body.u32(entry.crc);
        this.#body.u32(entry.compressed.byteLength);
        this.#body.u32(entry.rawSize);
        this.#body.u16(entry.name.byteLength);
        this.#body.u16(0); // extra field length
        this.#body.push(entry.name);
        this.#body.push(entry.compressed);
    }

    build(): Uint8Array {
        const out = new ByteWriter();
        out.push(this.#body.concat());
        const directoryOffset = out.length;

        for (const entry of this.#entries) {
            out.u32(0x02014b50); // central directory header
            out.u16(20); // version made by
            out.u16(20); // version needed
            out.u16(0x0800);
            out.u16(entry.method);
            out.u16(0);
            out.u16(0x21);
            out.u32(entry.crc);
            out.u32(entry.compressed.byteLength);
            out.u32(entry.rawSize);
            out.u16(entry.name.byteLength);
            out.u16(0); // extra
            out.u16(0); // comment
            out.u16(0); // disk number
            out.u16(0); // internal attrs
            out.u32(0); // external attrs
            out.u32(entry.offset);
            out.push(entry.name);
        }

        const directorySize = out.length - directoryOffset;
        out.u32(0x06054b50); // end of central directory
        out.u16(0);
        out.u16(0);
        out.u16(this.#entries.length);
        out.u16(this.#entries.length);
        out.u32(directorySize);
        out.u32(directoryOffset);
        out.u16(0); // comment length
        return out.concat();
    }
}
