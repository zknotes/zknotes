// Pure helpers over the local item and its wire shape, shared by the push and the pull sides of the
// sync engine. Nothing here touches IndexedDB, the network or the queue.
import type { EncryptedItem, LocalItem } from "$lib/core/db";

/**
 * True when some other local (non-purged) item still references the chunk set (a file conflict
 * share). Takes an already-fetched items snapshot (query "perf 14") instead of its own
 * `getAll("items")` — every call site already has one in hand (or can share one fetched once per
 * pull page) rather than re-scanning the whole item table per purged file.
 */
export function hasLocalChunkSetRef(
    items: readonly LocalItem[],
    chunkSetId: string,
    excludeItemId: string,
): boolean {
    return items.some(
        (it) => it.id !== excludeItemId && it.chunk_set_id === chunkSetId && it.purged_at == null,
    );
}

/**
 * Strip the client-only fields before sending to the server — every field LocalItem adds to
 * EncryptedItem. `conflict_of` especially: the copy↔original link is kept inside the ciphertext so
 * the server cannot see it.
 */
export function toWireFormat(item: LocalItem): EncryptedItem {
    const { dirty, localRev, conflict_of, sync_error, ...wire } = item;
    return wire;
}

/**
 * The inverse of `toWireFormat`: a server wire item → a LocalItem. It strips the server-only
 * `user_id`, coerces the four encrypted fields to `string | null` (base64 strings on the wire, null
 * on a tombstone) and sets `dirty:false`. One source of truth for wire→local — used by the pull and
 * by the conflict-overwrite branch (previously inline and slightly inconsistent: the pull coerced
 * all four fields, the conflict only the payload).
 */
export function wireToLocalItem(raw: EncryptedItem & { user_id?: string }): LocalItem {
    const { user_id: _userId, ...fields } = raw;
    const asStr = (v: unknown): string | null => (v && typeof v === "string" ? v : null);
    return {
        ...fields,
        encrypted_payload: asStr(fields.encrypted_payload),
        payload_nonce: asStr(fields.payload_nonce),
        encrypted_item_key: asStr(fields.encrypted_item_key),
        item_key_nonce: asStr(fields.item_key_nonce),
        dirty: false,
    };
}
