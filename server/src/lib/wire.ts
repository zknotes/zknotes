/**
 * Wire format helpers — the ONLY place where base64↔Buffer conversion happens for item and
 * snapshot rows. On the wire every encrypted blob is a base64 string; in the database it is a
 * Buffer. Route handlers must not do inline Buffer.from() conversions.
 */

type BlobLike = Buffer | Uint8Array | null | undefined;

export function bufToB64(value: BlobLike): string | null {
    return value ? Buffer.from(value).toString("base64") : null;
}

export function b64ToBuf(value: string | null | undefined): Buffer | null {
    return value ? Buffer.from(value, "base64") : null;
}

/** A Zod-validated base64 string — it throws if decoding fails. */
export function requireB64ToBuf(value: string): Buffer {
    const buf = b64ToBuf(value);
    if (!buf) throw new Error("Invalid base64");
    return buf;
}

/** A DB item row → the wire shape: strip `user_id`, and the 4 blob columns to base64. */
export function itemToWire<T extends Record<string, unknown>>(row: T) {
    const { user_id: _user_id, ...rest } = row as Record<string, unknown>;
    return {
        ...rest,
        encrypted_payload: bufToB64(row.encrypted_payload as BlobLike),
        payload_nonce: bufToB64(row.payload_nonce as BlobLike),
        encrypted_item_key: bufToB64(row.encrypted_item_key as BlobLike),
        item_key_nonce: bufToB64(row.item_key_nonce as BlobLike),
    };
}

/** A wire item (base64 blobs) → the DB blob columns (Buffer | null), for an insert/update spread. */
export function wireBlobsToRow(data: {
    encrypted_payload?: string | null;
    payload_nonce?: string | null;
    encrypted_item_key?: string | null;
    item_key_nonce?: string | null;
}): {
    encrypted_payload: Buffer | null;
    payload_nonce: Buffer | null;
    encrypted_item_key: Buffer | null;
    item_key_nonce: Buffer | null;
} {
    return {
        encrypted_payload: b64ToBuf(data.encrypted_payload),
        payload_nonce: b64ToBuf(data.payload_nonce),
        encrypted_item_key: b64ToBuf(data.encrypted_item_key),
        item_key_nonce: b64ToBuf(data.item_key_nonce),
    };
}

export function wireBlobsToRowPartial(data: {
    encrypted_payload?: string | null;
    payload_nonce?: string | null;
    encrypted_item_key?: string | null;
    item_key_nonce?: string | null;
}) {
    const out: {
        encrypted_payload?: Buffer | null;
        payload_nonce?: Buffer | null;
        encrypted_item_key?: Buffer | null;
        item_key_nonce?: Buffer | null;
    } = {};
    if (data.encrypted_payload !== undefined)
        out.encrypted_payload = b64ToBuf(data.encrypted_payload);
    if (data.payload_nonce !== undefined) out.payload_nonce = b64ToBuf(data.payload_nonce);
    if (data.encrypted_item_key !== undefined)
        out.encrypted_item_key = b64ToBuf(data.encrypted_item_key);
    if (data.item_key_nonce !== undefined) out.item_key_nonce = b64ToBuf(data.item_key_nonce);
    return out;
}

/** An item_history row → the wire shape (blobs in base64, created_at seconds → ms). */
export function snapshotToWire(r: {
    id: string;
    item_id: string;
    encrypted_payload: Buffer;
    payload_nonce: Buffer;
    encrypted_item_key: Buffer;
    item_key_nonce: Buffer;
    item_version_at_snapshot: number;
    created_at: number;
    snapshot_number?: number;
}) {
    return {
        id: r.id,
        item_id: r.item_id,
        encrypted_payload: bufToB64(r.encrypted_payload),
        payload_nonce: bufToB64(r.payload_nonce),
        encrypted_item_key: bufToB64(r.encrypted_item_key),
        item_key_nonce: bufToB64(r.item_key_nonce),
        item_version_at_snapshot: r.item_version_at_snapshot,
        snapshot_number: r.snapshot_number,
        created_at: r.created_at * 1000,
    };
}
