/**
 * Checking a Bitcoin block header the server relayed, before its time is shown on a seal.
 *
 * The header comes from a third-party block source through our server, so neither is trusted.
 * A header is accepted only if
 *   - its Merkle root is exactly the message the seal's own proof commits to at that height, and
 *   - its double-SHA-256 meets the target its `bits` field claims, and
 *   - that target is at least as hard as MIN_DIFFICULTY.
 * The last rule is what makes forgery expensive: anyone can mine a fake header at difficulty 1 in
 * seconds, but not one at mainnet-scale difficulty. Mainnet was at ~1.5·10¹⁴ when this was written;
 * 10¹³ leaves room for a large drop while still costing a forger far more than a seal's time is worth.
 *
 * The time in a header is the miner's clock. Consensus keeps it roughly honest (after the median
 * of the previous eleven blocks, at most two hours ahead of the network), so it is shown as the
 * time the content existed by, not as an exact instant.
 */

export const MIN_DIFFICULTY = 10_000_000_000_000n;

/** The difficulty-1 target (bits 0x1d00ffff). */
const MAX_TARGET = 0xffffn << (8n * (0x1dn - 3n));

export class BlockHeaderError extends Error {
    override name = "BlockHeaderError";
}

function fromHex(hex: string): Uint8Array {
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0)
        throw new BlockHeaderError("invalid hex");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** A little-endian byte string as an unsigned integer. */
function leToBigInt(bytes: Uint8Array): bigint {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] as number);
    return v;
}

function readU32LE(b: Uint8Array, offset: number): number {
    return new DataView(b.buffer, b.byteOffset + offset, 4).getUint32(0, true);
}

/** The target a compact `bits` value encodes; null for a negative or overflowing encoding. */
export function targetFromBits(bits: number): bigint | null {
    const exponent = BigInt(bits >>> 24);
    const mantissa = BigInt(bits & 0x007fffff);
    if (bits & 0x00800000) return null;
    return exponent <= 3n ? mantissa >> (8n * (3n - exponent)) : mantissa << (8n * (exponent - 3n));
}

async function sha256d(b: Uint8Array): Promise<Uint8Array> {
    const once = await crypto.subtle.digest("SHA-256", b as BufferSource);
    return new Uint8Array(await crypto.subtle.digest("SHA-256", once));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Checks `headerHex` against the attestation message (the Merkle root in the header's internal
 * byte order, as the OTS proof holds it). Returns the block time (Unix seconds) or throws.
 */
export async function checkBlockHeader(headerHex: string, merkleRoot: Uint8Array): Promise<number> {
    const header = fromHex(headerHex);
    if (header.length !== 80) throw new BlockHeaderError("a block header is 80 bytes");
    if (!equal(header.subarray(36, 68), merkleRoot)) {
        throw new BlockHeaderError("the header is not for the block this proof names");
    }
    const target = targetFromBits(readU32LE(header, 72));
    if (target === null || target === 0n) throw new BlockHeaderError("invalid difficulty bits");
    if (target * MIN_DIFFICULTY > MAX_TARGET) {
        throw new BlockHeaderError("the header's difficulty is far below the real chain's");
    }
    if (leToBigInt(await sha256d(header)) > target) {
        throw new BlockHeaderError("the header does not carry its proof of work");
    }
    return readU32LE(header, 68);
}
