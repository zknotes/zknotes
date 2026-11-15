/**
 * OpenTimestamps (OTS) proof format: an independent parser, serializer and tree merge, with no
 * network access. Written from the public wire format; it imports no OTS library.
 *
 * A proof is a tree of messages. Each edge is an operation that turns its parent's message into the
 * child's (append, prepend, a hash, ...), and a node may carry attestations: "pending at calendar X"
 * or "committed in Bitcoin block N". Serialization is canonical: attestations and ops are written in
 * a fixed sort order, so parse → serialize reproduces the original bytes of any proof the reference
 * client wrote, and a merge produces the same bytes the reference client would.
 *
 * Hashing uses WebCrypto: everything hashed here is public material (digests, nonces, Merkle paths),
 * and the client's crypto libraries are reserved for the crypto worker. WebCrypto has no RIPEMD-160
 * or Keccak-256. The format names both, but neither calendars nor Bitcoin attestations use them, so
 * a proof containing one is refused rather than half-evaluated.
 */

export class OtsError extends Error {
    override name = "OtsError";
}

// ── Limits (the same bounds the reference implementation enforces) ──────────────────────────────

const MAX_MSG_LENGTH = 4096;
const MAX_RESULT_LENGTH = 4096;
const MAX_PAYLOAD_SIZE = 8192;
const MAX_URI_LENGTH = 1000;
const MAX_VARUINT_BYTES = 9;
const MAX_DEPTH = 256;
const MAX_HEIGHT = 2 ** 32 - 1;
const URI_CHARS = /^[A-Za-z0-9\-._/:]*$/;

/** `\0OpenTimestamps\0\0Proof\0` followed by eight fixed bytes. */
export const HEADER_MAGIC = new Uint8Array([
    0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
    0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const MAJOR_VERSION = 1;

// ── Operations ───────────────────────────────────────────────────────────────────────────────────

export const OP = {
    sha1: 0x02,
    ripemd160: 0x03,
    sha256: 0x08,
    keccak256: 0x67,
    append: 0xf0,
    prepend: 0xf1,
    reverse: 0xf2,
    hexlify: 0xf3,
} as const;

/** The hash operations a detached proof may name as the hash of the stamped file. */
const DIGEST_LENGTH: Readonly<Record<number, number>> = {
    [OP.sha1]: 20,
    [OP.ripemd160]: 20,
    [OP.sha256]: 32,
    [OP.keccak256]: 32,
};

/** One edge of the tree. `arg` is set for append/prepend and `null` for every unary op. */
export type Op = { readonly tag: number; readonly arg: Uint8Array | null };

const isBinaryTag = (tag: number) => tag === OP.append || tag === OP.prepend;
const isKnownTag = (tag: number) => (Object.values(OP) as number[]).includes(tag);

export const appendOp = (arg: Uint8Array): Op => ({ tag: OP.append, arg });
export const prependOp = (arg: Uint8Array): Op => ({ tag: OP.prepend, arg });
export const sha256Op: Op = { tag: OP.sha256, arg: null };

function opKey(op: Op): string {
    return op.arg ? `${op.tag}:${toHex(op.arg)}` : `${op.tag}`;
}

/** Ops sort by tag, then (binary ops of one tag) by their argument bytes. */
function compareOps(a: Op, b: Op): number {
    if (a.tag !== b.tag) return a.tag - b.tag;
    return compareBytes(a.arg ?? EMPTY, b.arg ?? EMPTY);
}

async function digest(algorithm: "SHA-256" | "SHA-1", msg: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest(algorithm, msg as BufferSource));
}

/** SHA-256 through WebCrypto, for callers that hash public material next to a proof. */
export function sha256Bytes(msg: Uint8Array): Promise<Uint8Array> {
    return digest("SHA-256", msg);
}

/** Applies an op to a message, with the reference implementation's length rules. */
export async function applyOp(op: Op, msg: Uint8Array): Promise<Uint8Array> {
    const maxMsg = op.tag === OP.hexlify ? MAX_RESULT_LENGTH / 2 : MAX_MSG_LENGTH;
    if (msg.length > maxMsg) throw new OtsError(`message too long for op 0x${op.tag.toString(16)}`);
    let result: Uint8Array;
    switch (op.tag) {
        case OP.append:
            result = concat(msg, op.arg as Uint8Array);
            break;
        case OP.prepend:
            result = concat(op.arg as Uint8Array, msg);
            break;
        case OP.sha256:
            result = await digest("SHA-256", msg);
            break;
        case OP.sha1:
            result = await digest("SHA-1", msg);
            break;
        case OP.reverse:
            result = msg.slice().reverse();
            break;
        case OP.hexlify:
            result = new TextEncoder().encode(toHex(msg));
            break;
        default:
            throw new OtsError(`unsupported op 0x${op.tag.toString(16)}`);
    }
    if (result.length === 0) throw new OtsError("an op may not produce an empty message");
    if (result.length > MAX_RESULT_LENGTH) throw new OtsError("op result too long");
    return result;
}

// ── Attestations ─────────────────────────────────────────────────────────────────────────────────

const TAG_PENDING = fromHex("83dfe30d2ef90c8e");
const TAG_BITCOIN = fromHex("0588960d73d71901");
const TAG_LITECOIN = fromHex("06869a0d73d71b45");

export type Attestation =
    | { readonly kind: "pending"; readonly uri: string }
    | { readonly kind: "bitcoin"; readonly height: number }
    | { readonly kind: "litecoin"; readonly height: number }
    | { readonly kind: "unknown"; readonly tag: Uint8Array; readonly payload: Uint8Array };

function attestationTag(a: Attestation): Uint8Array {
    switch (a.kind) {
        case "pending":
            return TAG_PENDING;
        case "bitcoin":
            return TAG_BITCOIN;
        case "litecoin":
            return TAG_LITECOIN;
        case "unknown":
            return a.tag;
    }
}

function attestationKey(a: Attestation): string {
    switch (a.kind) {
        case "pending":
            return `p:${a.uri}`;
        case "bitcoin":
            return `b:${a.height}`;
        case "litecoin":
            return `l:${a.height}`;
        case "unknown":
            return `u:${toHex(a.tag)}:${toHex(a.payload)}`;
    }
}

/** Attestations sort by tag; two of one kind by URI, height, or payload. */
function compareAttestations(a: Attestation, b: Attestation): number {
    const byTag = compareBytes(attestationTag(a), attestationTag(b));
    if (byTag !== 0 || a.kind !== b.kind) return byTag;
    if (a.kind === "pending" && b.kind === "pending") {
        return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
    }
    if (
        (a.kind === "bitcoin" || a.kind === "litecoin") &&
        (b.kind === "bitcoin" || b.kind === "litecoin")
    ) {
        return a.height - b.height;
    }
    if (a.kind === "unknown" && b.kind === "unknown") return compareBytes(a.payload, b.payload);
    return 0;
}

function checkUri(uri: string): void {
    if (uri.length > MAX_URI_LENGTH) throw new OtsError("calendar URI too long");
    if (!URI_CHARS.test(uri)) throw new OtsError("calendar URI has a disallowed character");
}

function readAttestation(r: Reader): Attestation {
    const tag = r.bytes(8);
    const payload = new Reader(r.varbytes(MAX_PAYLOAD_SIZE));
    let a: Attestation;
    if (equalBytes(tag, TAG_PENDING)) {
        const uriBytes = payload.varbytes(MAX_URI_LENGTH);
        let uri: string;
        try {
            uri = new TextDecoder("utf-8", { fatal: true }).decode(uriBytes);
        } catch {
            throw new OtsError("calendar URI is not UTF-8");
        }
        checkUri(uri);
        a = { kind: "pending", uri };
    } else if (equalBytes(tag, TAG_BITCOIN) || equalBytes(tag, TAG_LITECOIN)) {
        const height = payload.varuint();
        if (height > MAX_HEIGHT) throw new OtsError("block height too large");
        a = { kind: equalBytes(tag, TAG_BITCOIN) ? "bitcoin" : "litecoin", height };
    } else {
        return { kind: "unknown", tag, payload: payload.rest() };
    }
    payload.assertEof();
    return a;
}

function writeAttestation(w: Writer, a: Attestation): void {
    w.bytes(attestationTag(a));
    const payload = new Writer();
    switch (a.kind) {
        case "pending":
            checkUri(a.uri);
            payload.varbytes(new TextEncoder().encode(a.uri));
            break;
        case "bitcoin":
        case "litecoin":
            payload.varuint(a.height);
            break;
        case "unknown":
            payload.bytes(a.payload);
            break;
    }
    w.varbytes(payload.finish());
}

// ── The tree ─────────────────────────────────────────────────────────────────────────────────────

export class Timestamp {
    readonly msg: Uint8Array;
    readonly attestations = new Map<string, Attestation>();
    readonly ops = new Map<string, { readonly op: Op; readonly stamp: Timestamp }>();

    constructor(msg: Uint8Array) {
        if (msg.length > MAX_MSG_LENGTH) throw new OtsError("message too long");
        this.msg = msg;
    }

    /** The child reached through `op`, created when it does not exist yet. */
    async addOp(op: Op): Promise<Timestamp> {
        const key = opKey(op);
        const existing = this.ops.get(key);
        if (existing) return existing.stamp;
        const stamp = new Timestamp(await applyOp(op, this.msg));
        this.ops.set(key, { op, stamp });
        return stamp;
    }

    addAttestation(a: Attestation): void {
        this.attestations.set(attestationKey(a), a);
    }

    /**
     * Adds every op and attestation of `other` (a tree for the same message) to this one. A branch
     * this tree lacks is adopted whole: its messages were computed when it was parsed.
     */
    merge(other: Timestamp): void {
        if (!equalBytes(this.msg, other.msg)) {
            throw new OtsError("cannot merge timestamps of different messages");
        }
        for (const [key, a] of other.attestations) this.attestations.set(key, a);
        for (const [key, branch] of other.ops) {
            const ours = this.ops.get(key);
            if (ours) ours.stamp.merge(branch.stamp);
            else this.ops.set(key, branch);
        }
    }

    /** Every attestation in the tree, with the message it attests to. */
    allAttestations(): Array<{ readonly msg: Uint8Array; readonly attestation: Attestation }> {
        const out: Array<{ msg: Uint8Array; attestation: Attestation }> = [];
        const walk = (t: Timestamp) => {
            for (const a of t.attestations.values()) out.push({ msg: t.msg, attestation: a });
            for (const { stamp } of t.ops.values()) walk(stamp);
        };
        walk(this);
        return out;
    }

    /** Every node whose message equals `msg`. */
    findNodes(msg: Uint8Array): Timestamp[] {
        const out: Timestamp[] = [];
        const walk = (t: Timestamp) => {
            if (equalBytes(t.msg, msg)) out.push(t);
            for (const { stamp } of t.ops.values()) walk(stamp);
        };
        walk(this);
        return out;
    }
}

/** A parsed node before its messages are known: the structure is read first, hashed after. */
type RawNode = {
    readonly attestations: Attestation[];
    readonly ops: Array<{ readonly op: Op; readonly child: RawNode }>;
};

function readNode(r: Reader, depth: number): RawNode {
    if (depth > MAX_DEPTH) throw new OtsError("timestamp nested too deeply");
    const node: RawNode = { attestations: [], ops: [] };
    const seen = new Set<string>();
    const one = (tag: number) => {
        if (tag === 0x00) {
            node.attestations.push(readAttestation(r));
            return;
        }
        if (!isKnownTag(tag)) throw new OtsError(`unknown op 0x${tag.toString(16)}`);
        const op: Op = { tag, arg: isBinaryTag(tag) ? r.varbytes(MAX_RESULT_LENGTH, 1) : null };
        const key = opKey(op);
        if (seen.has(key)) throw new OtsError("op repeated in one node");
        seen.add(key);
        node.ops.push({ op, child: readNode(r, depth + 1) });
    };
    let tag = r.byte();
    while (tag === 0xff) {
        one(r.byte());
        tag = r.byte();
    }
    one(tag);
    return node;
}

async function materialize(node: RawNode, msg: Uint8Array): Promise<Timestamp> {
    const t = new Timestamp(msg);
    for (const a of node.attestations) t.addAttestation(a);
    for (const { op, child } of node.ops) {
        t.ops.set(opKey(op), { op, stamp: await materialize(child, await applyOp(op, msg)) });
    }
    return t;
}

function writeTimestamp(w: Writer, t: Timestamp): void {
    const atts = [...t.attestations.values()].sort(compareAttestations);
    const ops = [...t.ops.values()].sort((a, b) => compareOps(a.op, b.op));
    if (atts.length === 0 && ops.length === 0) {
        throw new OtsError("an empty timestamp cannot be serialized");
    }
    const writeOp = (op: Op) => {
        w.byte(op.tag);
        if (op.arg) w.varbytes(op.arg);
    };
    // Every attestation but the last is a fork (0xff 0x00); the last closes the node when there are
    // no ops, and is a fork too when ops follow.
    for (const a of atts.slice(0, -1)) {
        w.bytes(FORK_ATTESTATION);
        writeAttestation(w, a);
    }
    const last = atts.at(-1);
    if (ops.length === 0) {
        w.byte(0x00);
        writeAttestation(w, last as Attestation);
        return;
    }
    if (last) {
        w.bytes(FORK_ATTESTATION);
        writeAttestation(w, last);
    }
    for (const { op, stamp } of ops.slice(0, -1)) {
        w.byte(0xff);
        writeOp(op);
        writeTimestamp(w, stamp);
    }
    const lastOp = ops.at(-1) as { op: Op; stamp: Timestamp };
    writeOp(lastOp.op);
    writeTimestamp(w, lastOp.stamp);
}

const FORK_ATTESTATION = new Uint8Array([0xff, 0x00]);

/** A bare timestamp for `msg`, as a calendar returns it (no header). The whole input must be used. */
export async function parseTimestamp(bytes: Uint8Array, msg: Uint8Array): Promise<Timestamp> {
    const r = new Reader(bytes);
    const node = readNode(r, 0);
    r.assertEof();
    return materialize(node, msg);
}

export function serializeTimestamp(t: Timestamp): Uint8Array {
    const w = new Writer();
    writeTimestamp(w, t);
    return w.finish();
}

// ── Detached proof file (`*.ots`) ────────────────────────────────────────────────────────────────

/** A `.ots` file: which hash was taken of the stamped file, and the tree rooted at that digest. */
export type DetachedProof = { readonly hashOp: number; readonly timestamp: Timestamp };

export async function parseDetached(bytes: Uint8Array): Promise<DetachedProof> {
    const r = new Reader(bytes);
    if (!equalBytes(r.bytes(HEADER_MAGIC.length), HEADER_MAGIC)) {
        throw new OtsError("not an OpenTimestamps proof");
    }
    if (r.byte() !== MAJOR_VERSION) throw new OtsError("unsupported proof version");
    const hashOp = r.byte();
    const length = DIGEST_LENGTH[hashOp];
    if (length === undefined) throw new OtsError("the file hash is not a known hash op");
    const msg = r.bytes(length);
    const node = readNode(r, 0);
    r.assertEof();
    return { hashOp, timestamp: await materialize(node, msg) };
}

export function serializeDetached(proof: DetachedProof): Uint8Array {
    if (DIGEST_LENGTH[proof.hashOp] !== proof.timestamp.msg.length) {
        throw new OtsError("digest length does not match the hash op");
    }
    const w = new Writer();
    w.bytes(HEADER_MAGIC);
    w.byte(MAJOR_VERSION);
    w.byte(proof.hashOp);
    w.bytes(proof.timestamp.msg);
    writeTimestamp(w, proof.timestamp);
    return w.finish();
}

// ── The seal's use of the format ─────────────────────────────────────────────────────────────────

/**
 * The tree a seal starts from: `digest → append(nonce) → sha256 = commitment`. Only the commitment
 * leaves the client; the nonce keeps the digest unguessable from it.
 */
export async function createSealTree(
    digestBytes: Uint8Array,
    nonce: Uint8Array,
): Promise<{ root: Timestamp; commitment: Timestamp }> {
    if (digestBytes.length !== 32) throw new OtsError("the digest must be 32 bytes");
    if (nonce.length !== 16) throw new OtsError("the nonce must be 16 bytes");
    const root = new Timestamp(digestBytes);
    const commitment = await (await root.addOp(appendOp(nonce))).addOp(sha256Op);
    return { root, commitment };
}

/** Merges a calendar's reply (a bare timestamp rooted at `msg`) into every node of `root` for `msg`. */
export async function mergeAt(root: Timestamp, msg: Uint8Array, reply: Uint8Array): Promise<void> {
    const nodes = root.findNodes(msg);
    if (nodes.length === 0) {
        throw new OtsError("the reply is for a message this proof does not contain");
    }
    const stamp = await parseTimestamp(reply, msg);
    for (const n of nodes) n.merge(stamp);
}

export type PendingRef = { readonly uri: string; readonly msg: Uint8Array };

/** The (calendar, message) pairs still waiting — what an upgrade asks the calendars about. */
export function pendingAttestations(root: Timestamp): PendingRef[] {
    const out: PendingRef[] = [];
    for (const { msg, attestation } of root.allAttestations()) {
        if (attestation.kind === "pending") out.push({ uri: attestation.uri, msg });
    }
    return out;
}

/** The Bitcoin block heights the proof reaches. Non-empty means the proof is complete. */
export function bitcoinHeights(root: Timestamp): number[] {
    const heights = new Set<number>();
    for (const { attestation } of root.allAttestations()) {
        if (attestation.kind === "bitcoin") heights.add(attestation.height);
    }
    return [...heights].sort((a, b) => a - b);
}

/** Where a proof reaches Bitcoin: the calendar's transaction and the 32 bytes its OP_RETURN holds. */
export type BitcoinAnchor = {
    readonly height: number;
    /** As block explorers print it: the reverse of the double-SHA-256 bytes. */
    readonly txid: string;
    /** The OP_RETURN payload, a message on the proof's own path (never the file's fingerprint). */
    readonly opReturn: string;
};

/** OP_RETURN followed by a 32-byte push. */
const OP_RETURN_PUSH32 = [0x6a, 0x20] as const;

/**
 * The Bitcoin transactions the proof passes through. A calendar commits its Merkle tip by
 * prepending and appending the rest of a transaction around it, then hashes the result twice:
 * that double SHA-256 is the txid, and the path goes on from it through the block's Merkle tree.
 *
 * A node counts as a transaction only when its message is longer than 64 bytes, its next two ops
 * are SHA-256, and it holds `OP_RETURN PUSH32 <x>` where `x` is the message of an ancestor on the
 * same path. Without the ancestor rule any double hash of a long message would pass. Messages were
 * computed when the proof was parsed, so nothing is hashed here.
 */
export function bitcoinAnchors(root: Timestamp): BitcoinAnchor[] {
    const found = new Map<string, BitcoinAnchor>();
    const unary = (t: Timestamp, tag: number) => t.ops.get(`${tag}`)?.stamp;
    const walk = (t: Timestamp, ancestors: Uint8Array[]) => {
        const once = unary(t, OP.sha256);
        const twice = once && unary(once, OP.sha256);
        if (twice && t.msg.length > 64) {
            const payload = opReturnFromAncestor(t.msg, ancestors);
            if (payload) {
                const txid = toHex(twice.msg.slice().reverse());
                for (const height of bitcoinHeights(twice)) {
                    found.set(`${height}:${txid}`, { height, txid, opReturn: toHex(payload) });
                }
            }
        }
        const next = [...ancestors, t.msg];
        for (const { stamp } of t.ops.values()) walk(stamp, next);
    };
    walk(root, []);
    return [...found.values()].sort((a, b) =>
        a.height !== b.height ? a.height - b.height : a.txid < b.txid ? -1 : 1,
    );
}

function opReturnFromAncestor(msg: Uint8Array, ancestors: Uint8Array[]): Uint8Array | null {
    for (let i = 0; i + 2 + 32 <= msg.length; i++) {
        if (msg[i] !== OP_RETURN_PUSH32[0] || msg[i + 1] !== OP_RETURN_PUSH32[1]) continue;
        const payload = msg.subarray(i + 2, i + 34);
        if (ancestors.some((a) => equalBytes(a, payload))) return payload.slice();
    }
    return null;
}

// ── Byte helpers ─────────────────────────────────────────────────────────────────────────────────

const EMPTY = new Uint8Array(0);

export function toHex(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
}

export function fromHex(hex: string): Uint8Array {
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new OtsError("invalid hex");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Lexicographic; a prefix sorts first. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const d = (a[i] as number) - (b[i] as number);
        if (d !== 0) return d;
    }
    return a.length - b.length;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

class Reader {
    private pos = 0;
    constructor(private readonly buf: Uint8Array) {}

    byte(): number {
        if (this.pos >= this.buf.length) throw new OtsError("unexpected end of proof");
        return this.buf[this.pos++] as number;
    }

    bytes(n: number): Uint8Array {
        if (this.pos + n > this.buf.length) throw new OtsError("unexpected end of proof");
        const out = this.buf.slice(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }

    /** Unsigned LEB128, at most nine bytes. Values beyond 2^53 are rejected rather than rounded. */
    varuint(): number {
        let value = 0;
        let scale = 1;
        for (let i = 0; i < MAX_VARUINT_BYTES; i++) {
            const b = this.byte();
            value += (b & 0x7f) * scale;
            if (!Number.isSafeInteger(value)) throw new OtsError("varuint too large");
            if ((b & 0x80) === 0) return value;
            scale *= 128;
        }
        throw new OtsError("varuint longer than nine bytes");
    }

    varbytes(max: number, min = 0): Uint8Array {
        const n = this.varuint();
        if (n > max) throw new OtsError("length field exceeds its limit");
        if (n < min) throw new OtsError("length field below its minimum");
        return this.bytes(n);
    }

    rest(): Uint8Array {
        return this.bytes(this.buf.length - this.pos);
    }

    assertEof(): void {
        if (this.pos !== this.buf.length) throw new OtsError("trailing bytes after the proof");
    }
}

class Writer {
    private readonly parts: number[] = [];

    byte(b: number): void {
        this.parts.push(b);
    }

    bytes(b: Uint8Array): void {
        for (const x of b) this.parts.push(x);
    }

    varuint(value: number): void {
        if (!Number.isSafeInteger(value) || value < 0) throw new OtsError("invalid varuint");
        let v = value;
        while (v > 0x7f) {
            this.parts.push((v % 128) | 0x80);
            v = Math.floor(v / 128);
        }
        this.parts.push(v);
    }

    varbytes(b: Uint8Array): void {
        this.varuint(b.length);
        this.bytes(b);
    }

    finish(): Uint8Array {
        return Uint8Array.from(this.parts);
    }
}
