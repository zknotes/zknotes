/**
 * The shape of a decrypted item payload — one source of truth.
 *
 * The payload is what the client encrypts into `encrypted_payload`; the server never sees it.
 * These types are the de-facto wire format between the web modules (sync, search, export, files),
 * which is why they live in the shared package — with no browser or Node dependency.
 */

/** One chunk in the encrypted manifest of a file payload. */
export interface ChunkRef {
    /** Base64 XChaCha20 nonce for this chunk. */
    nonce: string;
    /** Base64 SHA-256 hash of the ciphertext (integrity on download). */
    hash: string;
    /** Size of the ciphertext in bytes. */
    size: number;
}

export interface NotePayload {
    title: string;
    /** Title derived from the first line of the content (shown in the tree and in search). */
    contentTitle?: string;
    /** TipTap HTML content. */
    content: string;
    color?: string;
    icon?: string;
    starred?: boolean;
    /**
     * Legacy, read by nothing: the outline used to be remembered per note, and is now a single
     * sticky panel state in localStorage. Notes written before that still carry the key and backups
     * still round-trip it, so it stays in the type — it is simply never read or
     * written any more. Do not give it a new meaning; add a field instead.
     */
    outlineVisible?: boolean;
}

export interface FolderPayload {
    title: string;
    color?: string;
    icon?: string;
    starred?: boolean;
}

export interface FilePayload {
    kind: "file";
    chunkSetId: string;
    name: string;
    mime: string;
    size: number;
    chunkSize: number;
    chunks: ChunkRef[];
    description?: string;
    /** Base64 WebP/JPEG thumbnail (≤32 KB), present for raster images. */
    thumbnail?: string;
    /**
     * Intrinsic dimensions of the original in pixels — raster images only (anti-CLS).
     * Optional: files uploaded before these fields existed do not carry them and must keep
     * working. A durable record that survives rewrites of the note HTML (export/import, share,
     * history); the `encFile` node mirrors them into `data-w`/`data-h` so the NodeView reserves
     * space BEFORE decryption.
     */
    width?: number;
    height?: number;
}

/**
 * For call sites that decrypt an item of unknown or mixed type (tree load, search rebuild,
 * export) — every field optional.
 */
export type AnyItemPayload = Partial<NotePayload> &
    Partial<FilePayload> & {
        /**
         * Transient cross-device conflict marker: when present, this decrypted item is
         * a conflict copy of `conflict_of`. It lives inside the ciphertext so that it survives the
         * server round-trip; it is mirrored onto the plaintext `LocalItem.conflict_of` column on
         * pull and cleared on resolution. Not a persistent content field.
         */
        conflict_of?: string;
    };
