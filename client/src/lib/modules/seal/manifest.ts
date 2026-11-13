/**
 * The seal manifest: the small JSON document the OpenTimestamps proof is taken over. It ties the
 * proof to the file through a plain SHA-256, so a third party checks the link with tools they
 * already have (`sha256sum`, `shasum -a 256`), and the proof itself with the official OTS client.
 *
 * The bytes are canonical — keys sorted, UTF-8, no whitespace — because the proof commits to the
 * exact bytes: the same manifest must always serialize the same way.
 *
 * Deliberately absent: the file name, the item id and the chunk set id. The manifest goes to
 * whoever the user hands the certificate to; it should say nothing about their vault.
 */
import { sha256Bytes, toHex } from "./ots-protocol";

export const SEAL_SCHEMA = "zknotes-seal/1";

export type SealManifest = {
    readonly schema: typeof SEAL_SCHEMA;
    /** A random UUIDv4 naming this seal, unrelated to any id in the vault. */
    readonly seal_id: string;
    /** When the user sealed it, by their own clock (UTC, millisecond precision). A claim, not proof. */
    readonly sealed_at: string;
    /** SHA-256 of the file's plaintext bytes, lowercase hex. */
    readonly content_sha256: string;
    readonly content_type: string;
    readonly byte_length: number;
};

export class ManifestError extends Error {
    override name = "ManifestError";
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// A MIME type as the payload declares it: printable ASCII, no spaces at the ends.
const CONTENT_TYPE = /^[\x21-\x7e](?:[\x20-\x7e]{0,253}[\x21-\x7e])?$/;
const FALLBACK_CONTENT_TYPE = "application/octet-stream";
const KEYS = ["byte_length", "content_sha256", "content_type", "schema", "seal_id", "sealed_at"];

function validate(m: SealManifest): SealManifest {
    if (m.schema !== SEAL_SCHEMA) throw new ManifestError("unknown manifest schema");
    if (!UUID_V4.test(m.seal_id)) throw new ManifestError("seal_id must be a lowercase UUIDv4");
    if (!ISO_UTC_MS.test(m.sealed_at) || Number.isNaN(Date.parse(m.sealed_at))) {
        throw new ManifestError("sealed_at must be an ISO-8601 UTC timestamp");
    }
    if (!SHA256_HEX.test(m.content_sha256))
        throw new ManifestError("content_sha256 must be 64 hex digits");
    if (!CONTENT_TYPE.test(m.content_type)) throw new ManifestError("invalid content_type");
    if (!Number.isSafeInteger(m.byte_length) || m.byte_length < 0) {
        throw new ManifestError("byte_length must be a non-negative integer");
    }
    return m;
}

export function newManifest(
    input: { contentSha256: string; contentType: string; byteLength: number },
    now: Date = new Date(),
    sealId: string = crypto.randomUUID(),
): SealManifest {
    const type = input.contentType.trim();
    return validate({
        schema: SEAL_SCHEMA,
        seal_id: sealId,
        sealed_at: now.toISOString(),
        content_sha256: input.contentSha256,
        content_type: CONTENT_TYPE.test(type) ? type : FALLBACK_CONTENT_TYPE,
        byte_length: input.byteLength,
    });
}

/** The canonical bytes: sorted keys, no whitespace, UTF-8. */
export function encodeManifest(m: SealManifest): Uint8Array {
    validate(m);
    const record = m as unknown as Record<string, string | number>;
    const body = KEYS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(record[k])}`).join(",");
    return new TextEncoder().encode(`{${body}}`);
}

/** Parses manifest bytes and refuses anything that is not already in canonical form. */
export function decodeManifest(bytes: Uint8Array): SealManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        throw new ManifestError("the manifest is not valid UTF-8 JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ManifestError("the manifest must be a JSON object");
    }
    const keys = Object.keys(parsed).sort();
    if (keys.join(",") !== KEYS.join(",")) throw new ManifestError("unexpected manifest fields");
    const m = validate(parsed as SealManifest);
    const again = encodeManifest(m);
    if (toHex(again) !== toHex(bytes)) throw new ManifestError("the manifest is not canonical");
    return m;
}

/**
 * SHA-256 of the manifest bytes — the digest the OpenTimestamps proof starts from. (The content
 * hash of the file itself is computed incrementally in the crypto worker, chunk by chunk.)
 */
export function manifestDigest(bytes: Uint8Array): Promise<Uint8Array> {
    return sha256Bytes(bytes);
}
