// The encrypted backup container. A password-protected Full Backup: a separate passphrase →
// Argon2id (a random salt) → an XChaCha20-Poly1305 chunked stream. Plaintext never touches the disk;
// the ZIP is packed in memory entry by entry, and the ZIP bytes are encrypted frame by frame and streamed out.
//
// The file format (.cnbackup):
//   MAGIC (8 ASCII bytes "CRNOTBK1")
//   headerLen (u32 big-endian)
//   header (UTF-8 JSON: { v, kdf_salt, kdf_params, chunk_size })
//   frames…  — each: nonce(24) ‖ ctLen(u32 BE) ‖ ciphertext
//
// One frame's plaintext is a contiguous slice of ZIP bytes (≤ chunk_size). Each frame's AAD binds
// its index and a "final" flag (`cnbk:<i>:<0|1>`): the last frame is the only one with final=1, so
// truncation — a missing tail of the stream — is detected because the second-to-last frame does not
// decrypt as final.

import {
    DEFAULT_KDF_PARAMS,
    decryptChunk,
    deriveMasterKey,
    encryptChunk,
    generateSalt,
    type KdfParams,
    KdfParamsSchema,
    MAX_KDF_MEMORY_KIB,
    zeroize,
} from "@zknotes/shared";
import { fromBase64, toBase64 } from "$lib/core/utils/base64";

/** "CRNOTBK1" — recognises an encrypted backup without parsing the header. */
export const BACKUP_MAGIC = new Uint8Array([67, 82, 78, 79, 84, 66, 75, 49]);
/** Plaintext bytes per frame. 1 MiB keeps peak memory small with a solid AEAD ratio. */
export const DEFAULT_BACKUP_CHUNK_SIZE = 1024 * 1024;
/** The recommended extension for an encrypted backup. */
export const ENCRYPTED_BACKUP_EXT = "cnbackup";

const NONCE_LEN = 24;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface BackupHeader {
    v: 1;
    kdf_salt: string;
    kdf_params: KdfParams;
    chunk_size: number;
}

/** The AAD binding a frame to its position in the stream and to whether it is the last (anti-reorder, anti-truncation). */
function frameAad(index: number, final: boolean): Uint8Array {
    return textEncoder.encode(`cnbk:${index}:${final ? 1 : 0}`);
}

function u32be(n: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    return b;
}

function readU32be(buf: Uint8Array, offset: number): number {
    return new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, false);
}

function concat(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

function encodeHeaderPrefix(header: BackupHeader): Uint8Array {
    const json = textEncoder.encode(JSON.stringify(header));
    return concat([BACKUP_MAGIC, u32be(json.length), json]);
}

/**
 * A streaming encryptor: `push` takes arbitrary ZIP bytes and returns bytes to write (the header on
 * the first call, plus every filled frame); `finish` flushes the remainder as the final frame.
 * The key is derived from the passphrase in `create` and zeroized in `finish`.
 */
export class BackupEncryptor {
    private readonly pending: Uint8Array[] = [];
    private pendingLen = 0;
    private index = 0;
    private headerEmitted = false;

    static async create(
        passphrase: string,
        chunkSize: number = DEFAULT_BACKUP_CHUNK_SIZE,
    ): Promise<BackupEncryptor> {
        const salt = generateSalt();
        const params = DEFAULT_KDF_PARAMS;
        const key = await deriveMasterKey(passphrase, salt, params);
        const headerPrefix = encodeHeaderPrefix({
            v: 1,
            kdf_salt: toBase64(salt),
            kdf_params: params,
            chunk_size: chunkSize,
        });
        return new BackupEncryptor(key, headerPrefix, chunkSize);
    }

    private constructor(
        private readonly key: Uint8Array,
        private readonly headerPrefix: Uint8Array,
        private readonly chunkSize: number,
    ) {}

    push(data: Uint8Array): Uint8Array {
        const out: Uint8Array[] = [];
        if (!this.headerEmitted) {
            out.push(this.headerPrefix);
            this.headerEmitted = true;
        }
        if (data.length > 0) {
            this.pending.push(data);
            this.pendingLen += data.length;
        }
        while (this.pendingLen >= this.chunkSize) {
            out.push(this.emitFrame(this.take(this.chunkSize), false));
        }
        return concat(out);
    }

    /** Flush the leftover buffer as the final frame — possibly empty, an EOF sentinel — and zeroize the key. */
    finish(): Uint8Array {
        const out: Uint8Array[] = [];
        if (!this.headerEmitted) {
            out.push(this.headerPrefix);
            this.headerEmitted = true;
        }
        out.push(this.emitFrame(this.take(this.pendingLen), true));
        zeroize(this.key);
        return concat(out);
    }

    private take(n: number): Uint8Array {
        const result = new Uint8Array(n);
        let filled = 0;
        while (filled < n) {
            // biome-ignore lint/style/noNonNullAssertion: pendingLen guarantees enough bytes are queued
            const head = this.pending[0]!;
            const need = n - filled;
            if (head.length <= need) {
                result.set(head, filled);
                filled += head.length;
                this.pending.shift();
            } else {
                result.set(head.subarray(0, need), filled);
                this.pending[0] = head.subarray(need);
                filled += need;
            }
        }
        this.pendingLen -= n;
        return result;
    }

    private emitFrame(plaintext: Uint8Array, final: boolean): Uint8Array {
        const { ciphertext, nonce } = encryptChunk(
            plaintext,
            this.key,
            frameAad(this.index, final),
        );
        this.index++;
        return concat([nonce, u32be(ciphertext.length), ciphertext]);
    }
}

/** true when the bytes begin with the backup magic number. */
export function isEncryptedBackup(buf: Uint8Array): boolean {
    if (buf.length < BACKUP_MAGIC.length) return false;
    for (let i = 0; i < BACKUP_MAGIC.length; i++) {
        if (buf[i] !== BACKUP_MAGIC[i]) return false;
    }
    return true;
}

/**
 * Decrypts a whole encrypted backup buffer back into ZIP bytes. Buffer-based rather than streaming:
 * the import already loads the entire file, and knowing the last frame makes the final/truncation
 * check
 * simple and dependable. It throws on a wrong password, on tampering, or on an incomplete stream.
 */
export async function decryptBackup(buf: Uint8Array, passphrase: string): Promise<Uint8Array> {
    if (!isEncryptedBackup(buf)) throw new Error("That is not a ZKnotes encrypted backup.");

    const headerLen = readU32be(buf, BACKUP_MAGIC.length);
    const bodyOffset = BACKUP_MAGIC.length + 4 + headerLen;
    if (bodyOffset > buf.length) throw new Error("This backup is damaged (an invalid header).");

    const header = JSON.parse(
        textDecoder.decode(buf.subarray(BACKUP_MAGIC.length + 4, bodyOffset)),
    ) as BackupHeader;
    if (header.v !== 1) throw new Error(`Unsupported encrypted backup version (${header.v}).`);
    const parsedKdfParams = KdfParamsSchema.parse(header.kdf_params);
    if (parsedKdfParams.m > MAX_KDF_MEMORY_KIB) {
        throw new Error(
            `This backup needs too much memory to decrypt (${parsedKdfParams.m} KiB > ${MAX_KDF_MEMORY_KIB} KiB).`,
        );
    }

    // Scan the frame boundaries so we know which one is the final one before decrypting.
    const frames: Array<{ nonce: Uint8Array; ct: Uint8Array }> = [];
    let off = bodyOffset;
    while (off < buf.length) {
        if (off + NONCE_LEN + 4 > buf.length)
            throw new Error("This backup is damaged (an incomplete frame).");
        const nonce = buf.subarray(off, off + NONCE_LEN);
        const ctLen = readU32be(buf, off + NONCE_LEN);
        const ctStart = off + NONCE_LEN + 4;
        if (ctStart + ctLen > buf.length)
            throw new Error("This backup is damaged (an incomplete frame).");
        frames.push({ nonce, ct: buf.subarray(ctStart, ctStart + ctLen) });
        off = ctStart + ctLen;
    }
    if (frames.length === 0) throw new Error("This backup is empty or damaged.");

    const salt = fromBase64(header.kdf_salt);
    const key = await deriveMasterKey(passphrase, salt, header.kdf_params);
    try {
        const parts: Uint8Array[] = [];
        let totalLen = 0;
        for (let i = 0; i < frames.length; i++) {
            const final = i === frames.length - 1;
            // biome-ignore lint/style/noNonNullAssertion: i is within the bounds of frames
            const { nonce, ct } = frames[i]!;
            try {
                const plain = decryptChunk(ct, nonce, key, frameAad(i, final));
                parts.push(plain);
                totalLen += plain.byteLength;
            } catch {
                throw new Error("Wrong password, or a damaged backup.");
            }
        }
        const out = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) {
            out.set(p, offset);
            offset += p.byteLength;
        }
        return out;
    } finally {
        zeroize(key);
    }
}
