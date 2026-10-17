import type { EncryptedItem } from "@zknotes/shared";
import type { DBSchema, IDBPDatabase } from "idb";
import { openDB } from "idb";

export type { EncryptedItem };

/** LocalItem extends the wire-format EncryptedItem with client-only sync metadata. */
export interface LocalItem extends EncryptedItem {
    dirty?: boolean; // true = changed locally, awaiting a push
    localRev?: number; // A monotonic counter for detecting races during a sync
    conflict_of?: string; // The original document's ID; it stays until the user resolves the conflict
    sync_error?: string; // The message when a push failed permanently
}

export interface MutationQueueItem {
    id: string;
    type: "upsert" | "delete";
    attempted_at: number;
    attempt_count: number; // for the exponential backoff
}

export interface ZKnotesDBSchema extends DBSchema {
    items: {
        key: string;
        value: LocalItem;
    };
    "search-index": {
        key: string;
        value: {
            id: string; // usually just 'index'
            ciphertext: Uint8Array;
            nonce: Uint8Array;
            ikCiphertext: Uint8Array;
            ikNonce: Uint8Array;
        };
    };
    "mutation-queue": {
        key: string;
        value: MutationQueueItem;
        indexes: { "by-attempt": number };
    };
    metadata: {
        key: string;
        value: unknown;
    };
    /**
     * Plaintext blobs for images pasted or dropped into the editor that are awaiting encryption
     * and upload as `type:"file"` items (an offline-capable upload queue). The encFile
     * node renders straight out of this blob (`data-file-id="local:<local_id>"`) and the reference is
     * rewritten to the real fileItemId only after a successful upload. It survives a reload so an
     * interrupted upload can resume.
     */
    "pending-uploads": {
        key: string; // local_id
        value: PendingUpload;
    };
    /**
     * The persistent cache of encrypted file chunks — the ONLY layer that
     * makes files available offline. It holds **ciphertext ONLY** (the same zero-knowledge invariant
     * as `items.encrypted_payload`); decrypted plaintext NEVER comes here (it lives only in the RAM
     * `blob-cache`). It is cached by `chunkSetId`, NOT by itemId, because chunks are immutable
     * and tied to a chunk set — a file's conflict copy shares the same `chunk_set_id` and so reuses the cache.
     */
    "file-chunks": {
        key: string; // `${chunkSetId}:${index}`
        value: LocalChunk;
        indexes: { "by-chunk-set": string };
    };
    /**
     * Temporary staging ciphertext for a resumable upload.
     * Holds the ciphertext plus the nonce BEFORE the PUT; cleared on a chunk confirm or an abort.
     * Kept apart from `file-chunks` (the download cache) — a different lifecycle.
     */
    "upload-chunks": {
        key: string; // `${pendingLocalId}:${index}`
        value: StagedUploadChunk;
        indexes: { "by-pending": string };
    };
}

/** A temporary upload staging chunk — the ciphertext + the manifest metadata. */
export interface StagedUploadChunk {
    key: string;
    pendingLocalId: string;
    index: number;
    ciphertext: Uint8Array;
    nonce: string;
    hash: string;
    size: number;
    storedAt: number;
}

/** One cached encrypted chunk — ciphertext only. */
export interface LocalChunk {
    /** The composite key `${chunkSetId}:${index}` (the keyPath). */
    key: string;
    chunkSetId: string;
    index: number;
    /** The ciphertext bytes (XChaCha20-Poly1305) — no plaintext. */
    ciphertext: Uint8Array;
    /** The base64-decoded XChaCha nonce for this chunk (from the payload's manifest). */
    nonce: Uint8Array;
    storedAt: number;
}

/** A manifest entry per chunk index. */
export interface ManifestChunkEntry {
    nonce: string;
    hash: string;
    size: number;
    local_state: "persisted" | "confirmed";
}

export type UploadPhase =
    | "awaiting_confirm"
    | "staging_source"
    | "opening_session"
    | "uploading"
    | "paused"
    | "finalizing"
    | "committing_item"
    | "syncing"
    | "orphan_committed"
    | "done"
    | "user_aborted"
    | "failed_recoverable"
    | "failed_expired";

/**
 * The extended pending-uploads queue (v8).
 * `blob` remains for the legacy/editor path until that path moves onto OPFS staging.
 */
export interface PendingUpload {
    local_id: string;
    phase?: UploadPhase;
    name: string;
    mime: string;
    plain_size?: number;
    note_id: string | null;
    parent_id: string | null; // where the resulting file item ends up (the note's folder)
    created_at: number;
    last_activity_at?: number;

    /** The legacy plaintext blob — it goes away with OPFS staging. */
    blob?: Blob;

    staging_id?: string;
    staging_bytes_written?: number;

    chunk_set_id?: string;
    item_id?: string;
    encrypted_item_key?: string;
    item_key_nonce?: string;
    chunk_size?: number;
    total_chunks?: number;
    ciphertext_size?: number;
    chunk_sizes?: number[];

    manifest?: Record<number, ManifestChunkEntry>;

    /**
     * Multi-tab upload ownership. `fence` is a monotonic epoch: the tab that takes the lease
     * increments the fence; an older tab with a lower fence has to give up on renew/finalize.
     */
    upload_lock?: { tab_id: string; acquired_at: number; fence: number };
    last_error?: string;

    /** How the plaintext is stored locally. */
    storage_mode?: "opfs" | "idb_blob" | "ephemeral";
}

let dbPromise: Promise<IDBPDatabase<ZKnotesDBSchema>> | null = null;

export function getDB() {
    if (!dbPromise) {
        dbPromise = openDB<ZKnotesDBSchema>("zknotes-v1", 9, {
            // If THIS tab holds an old version open while another tab needs the upgrade, close our
            // connection so the upgrade can proceed (otherwise the other tab hangs forever).
            blocking() {
                console.warn(
                    "IndexedDB upgrade requested by another tab — closing this connection",
                );
                dbPromise?.then((db) => db.close());
                dbPromise = null;
            },
            // We are the tab attempting the upgrade, but an older connection is still open elsewhere.
            blocked() {
                console.warn(
                    "IndexedDB upgrade blocked by another open tab — close other ZKnotes tabs",
                );
            },
            terminated() {
                dbPromise = null;
            },
            upgrade(db, oldVersion) {
                if (oldVersion < 1) {
                    db.createObjectStore("search-index", { keyPath: "id" });
                    const mq = db.createObjectStore("mutation-queue", { keyPath: "id" });
                    mq.createIndex("by-attempt", "attempted_at");
                    db.createObjectStore("metadata");
                }
                if (oldVersion < 2) {
                    const rawDb = db as unknown as IDBDatabase;
                    if (rawDb.objectStoreNames.contains("encryption")) {
                        rawDb.deleteObjectStore("encryption");
                    }
                    if (!db.objectStoreNames.contains("items")) {
                        db.createObjectStore("items", { keyPath: "id" });
                    }
                }
                // v3: LocalItem.dirty + MutationQueueItem.attempt_count
                // There are no structural IndexedDB changes — these are only
                // new optional properties on existing object stores.
                if (oldVersion < 4) {
                    // v4: the offline upload queue for editor images
                    if (!db.objectStoreNames.contains("pending-uploads")) {
                        db.createObjectStore("pending-uploads", { keyPath: "local_id" });
                    }
                }
                if (oldVersion < 5) {
                    // v5: a reverse index for the "Used in N notes" delete guard.
                    // Removed in v6; its creation is kept so v4→v6 upgrades still work.
                    const rawDb = db as unknown as IDBDatabase;
                    if (!rawDb.objectStoreNames.contains("note-file-refs")) {
                        const refs = rawDb.createObjectStore("note-file-refs", {
                            keyPath: "note_id",
                        });
                        refs.createIndex("by-file", "file_ids", { multiEntry: true });
                    }
                }
                if (oldVersion < 6) {
                    // v6: drop note-file-refs (the V3 lifecycle has no shared blobs, so the reverse index is obsolete)
                    const rawDb = db as unknown as IDBDatabase;
                    if (rawDb.objectStoreNames.contains("note-file-refs")) {
                        rawDb.deleteObjectStore("note-file-refs");
                    }
                }
                if (oldVersion < 7) {
                    // v7: the persistent cache of encrypted file chunks.
                    // Additive — it does not touch existing stores.
                    if (!db.objectStoreNames.contains("file-chunks")) {
                        const chunks = db.createObjectStore("file-chunks", { keyPath: "key" });
                        // Enumerating every chunk of one set (deleteChunkSet / hasAllChunks).
                        chunks.createIndex("by-chunk-set", "chunkSetId");
                    }
                }
                if (oldVersion < 8) {
                    // v8: resumable upload state machine.
                    // A version bump only — the pending-uploads fields are additive on existing rows.
                }
                if (oldVersion < 9) {
                    // v9: the temporary upload staging ciphertext.
                    if (!db.objectStoreNames.contains("upload-chunks")) {
                        const staged = db.createObjectStore("upload-chunks", { keyPath: "key" });
                        staged.createIndex("by-pending", "pendingLocalId");
                    }
                }
            },
        });
    }
    return dbPromise;
}

/**
 * The number of mutations awaiting a push to the server (the offline/pending UX).
 * Derived from `mutation-queue` — NOT a new source of truth, only the current count.
 */
export async function getPendingMutationCount(): Promise<number> {
    const db = await getDB();
    return db.count("mutation-queue");
}

export async function setWatermark(serverTime: number) {
    const db = await getDB();
    await db.put("metadata", serverTime, "server_time");
}

export async function getWatermark(): Promise<number> {
    const db = await getDB();
    const val = await db.get("metadata", "server_time");
    return (val as number) || 0;
}
