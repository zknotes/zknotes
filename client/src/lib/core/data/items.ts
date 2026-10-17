import type { AnyItemPayload } from "@zknotes/shared";
import { decryptManyItemPayloads } from "$lib/core/crypto/item-codec";
import { getDB, type LocalItem } from "$lib/core/db";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";

export interface DecryptedItemMeta {
    id: string;
    type: "note" | "folder" | "file";
    parent_id: string | null;
    sort_order: string;
    title: string;
    color?: string;
    icon?: string;
    starred?: boolean;
    updated_at: number;
    // File metadata only. `title` mirrors the file's name, for a uniform display.
    mime?: string;
    size?: number; // plaintext bytes
    description?: string;
    // Plaintext sync metadata (never decrypted) — for the UI indicators only.
    dirty?: boolean;
    /** The server version — the server increments it on every successful push. 1 plus dirty = never pushed. */
    version: number;
    /** A monotonic localRev — it increments on every local edit (race detection). */
    localRev?: number;
    /** When this is a conflict copy, it holds the original item's ID. */
    conflict_of?: string;
}

export interface DeletedItemMeta extends DecryptedItemMeta {
    deleted_at: number;
    /** Set when a file or note went to Trash together with its owner (a note deletion). */
    trashed_batch_id?: string | null;
}

/** Counts one note's TRASHED files within the same trash batch (the badge in the /trash accordion). */
export function countBatchAttachments(
    deleted: DeletedItemMeta[],
    noteId: string,
    batchId: string,
): number {
    return batchAttachmentsForNote(deleted, noteId, batchId).length;
}

/** Files deleted together with a note (hidden from the main trash list). */
export function batchAttachmentsForNote(
    deleted: DeletedItemMeta[],
    noteId: string,
    batchId: string | null | undefined,
): DeletedItemMeta[] {
    if (!batchId) return [];
    return deleted.filter(
        (i) => i.type === "file" && i.parent_id === noteId && i.trashed_batch_id === batchId,
    );
}

/** Individually deleted files — their own row in /trash, not batched with a note. */
export function isIndividualTrashFile(item: DeletedItemMeta): boolean {
    return item.type === "file" && (item.trashed_batch_id == null || item.trashed_batch_id === "");
}

/**
 * The rows /trash shows in its main list (the "all" filter): notes/folders + individually trashed
 * files. Batched files, deleted along with a note, go into the accordion and are not counted
 * separately — the same place of truth for the sidebar badge and the page header.
 */
export function isVisibleTrashRow(item: DeletedItemMeta): boolean {
    return item.type === "note" || item.type === "folder" || isIndividualTrashFile(item);
}

export function countVisibleTrashItems(deleted: readonly DeletedItemMeta[]): number {
    return deleted.filter(isVisibleTrashRow).length;
}

export interface PathSegment {
    id: string;
    title: string;
    /** Whether this ancestor is itself in the Trash (or missing from the map). */
    deleted: boolean;
}

/**
 * The only source of truth for "where an item lives": it walks the `parent_id` chain and returns
 * the segments from the root downwards (excluding the item itself). The Files list, FileDetailPanel
 * and the Trash breadcrumb all use it. Cycle-safe.
 */
export function folderPathSegments(
    parentId: string | null,
    byId: Map<string, { title: string; parent_id: string | null; deleted?: boolean }>,
): PathSegment[] {
    const segments: PathSegment[] = [];
    const seen = new Set<string>();
    let pid = parentId;
    while (pid && !seen.has(pid)) {
        seen.add(pid);
        const p = byId.get(pid);
        if (!p) {
            segments.unshift({ id: pid, title: "Unknown", deleted: true });
            break;
        }
        segments.unshift({ id: pid, title: p.title || "Untitled", deleted: !!p.deleted });
        pid = p.parent_id;
    }
    return segments;
}

import { loadPersisted, rawStringSerde, STORAGE_KEYS } from "$lib/core/utils/persisted";

interface DecryptedFields {
    title: string;
    color?: string;
    icon?: string;
    starred?: boolean;
    mime?: string;
    size?: number;
    description?: string;
}

interface MetaCacheEntry {
    version: number;
    localRev: number | undefined;
    /** `null` = decryption failed for this (version, localRev) pair — it shows as "Encrypted…". */
    fields: DecryptedFields | null;
}

/**
 * A cache of decrypted metadata keyed by `(id, version, localRev)` — `getTreeItems` and
 * `getDeletedItems` used to re-decrypt EVERY item on each invalidation; with this cache only
 * what really changed is decrypted again. It lives as long as the tab is open; it is cleared by
 * `resetItemMetaCache()` (logout/account switch — teardownSession).
 */
const decryptedMetaCache = new Map<string, MetaCacheEntry>();

/** Called from teardownSession — it prevents keys and metadata leaking between accounts. */
export function resetItemMetaCache(): void {
    decryptedMetaCache.clear();
}

function toDecryptedFields(payload: AnyItemPayload): DecryptedFields {
    return {
        // For files the display name is in `name`; notes and folders use `title`.
        title: payload.name || payload.title || "Untitled",
        color: payload.color,
        icon: payload.icon,
        starred: payload.starred,
        mime: payload.mime,
        size: payload.size,
        description: payload.description,
    };
}

/**
 * Decrypts the metadata of every item passed in, using `decryptedMetaCache`: a cache hit
 * leaves an item untouched, while cache misses go into ONE batched worker round trip.
 */
async function decryptMetaBatch(
    items: readonly LocalItem[],
): Promise<Map<string, DecryptedFields | null>> {
    const out = new Map<string, DecryptedFields | null>();
    const toDecrypt = new Map<string, LocalItem>();

    for (const item of items) {
        const cached = decryptedMetaCache.get(item.id);
        if (cached && cached.version === item.version && cached.localRev === item.localRev) {
            out.set(item.id, cached.fields);
        } else {
            toDecrypt.set(item.id, item);
        }
    }

    if (toDecrypt.size > 0) {
        const results = await decryptManyItemPayloads<AnyItemPayload>([...toDecrypt.values()]);
        for (const r of results) {
            const item = toDecrypt.get(r.id);
            if (!item) continue;
            if (r.error) console.error(`Failed to decrypt metadata for item ${r.id}`, r.error);
            const fields = !r.error && r.data ? toDecryptedFields(r.data) : null;
            decryptedMetaCache.set(r.id, {
                version: item.version,
                localRev: item.localRev,
                fields,
            });
            out.set(r.id, fields);
        }
    }

    return out;
}

/**
 * Fetches every item from the IndexedDB database and decrypts only the metadata (the title and the
 * basic information), without loading a note's whole body
 * so the tree stays fast.
 */
export async function getTreeItems(): Promise<DecryptedItemMeta[]> {
    if (loadPersisted(STORAGE_KEYS.pendingClearForUser, "false", rawStringSerde) === "true") {
        return [];
    }

    const db = await getDB();
    const tx = db.transaction("items", "readonly");
    const store = tx.objectStore("items");
    const items = await store.getAll();

    // Clear the cache entries for items no longer in IDB (a hard delete or purge) — this prevents
    // unbounded growth across a long session.
    const currentIds = new Set(items.map((i) => i.id));
    for (const id of decryptedMetaCache.keys()) {
        if (!currentIds.has(id)) decryptedMetaCache.delete(id);
    }

    // The tree shows only READY items (stateOf is the one source of state — it catches a purged
    // tombstone too) and hides the conflict copies (which are visible in the Inbox).
    const readyItems = items.filter(
        (item) => FileLifecycle.stateOf(item) === "READY" && !item.conflict_of,
    );
    const decrypted = await decryptMetaBatch(readyItems);

    const treeItems: DecryptedItemMeta[] = readyItems.map((item) => {
        const fields = decrypted.get(item.id) ?? null;
        return {
            id: item.id,
            type: item.type,
            parent_id: item.parent_id,
            sort_order: item.sort_order,
            title: fields?.title ?? "Encrypted...",
            color: fields?.color,
            icon: fields?.icon,
            starred: fields?.starred,
            updated_at: item.updated_at ?? item.version,
            mime: fields?.mime,
            size: fields?.size,
            description: fields?.description,
            dirty: item.dirty,
            version: item.version,
            localRev: item.localRev,
            conflict_of: item.conflict_of,
        };
    });

    return treeItems;
}

export async function getDeletedItems(): Promise<DeletedItemMeta[]> {
    if (loadPersisted(STORAGE_KEYS.pendingClearForUser, "false", rawStringSerde) === "true") {
        return [];
    }

    const db = await getDB();
    const items = await db.getAll("items");

    // Trash shows the TRASHED state exclusively (correctly filtering out partial-upload junk and purged
    // rows) and hides the conflict copies (those are visible in the Inbox).
    const trashedItems = items.filter(
        (item) => FileLifecycle.stateOf(item) === "TRASHED" && !item.conflict_of,
    );
    const decrypted = await decryptMetaBatch(trashedItems);

    const deleted: DeletedItemMeta[] = trashedItems.map((item) => {
        const fields = decrypted.get(item.id) ?? null;
        // TRASHED ⟹ deleted_at is set; the `?? 0` merely satisfies the type (that branch never runs).
        return {
            id: item.id,
            type: item.type,
            parent_id: item.parent_id,
            sort_order: item.sort_order,
            title: fields?.title ?? "Encrypted...",
            color: fields?.color,
            icon: fields?.icon,
            starred: fields?.starred,
            updated_at: item.updated_at ?? item.version,
            deleted_at: item.deleted_at ?? 0,
            trashed_batch_id: item.trashed_batch_id ?? null,
            mime: fields?.mime,
            size: fields?.size,
            version: item.version,
            localRev: item.localRev,
        };
    });

    return deleted.sort((a, b) => b.deleted_at - a.deleted_at);
}
