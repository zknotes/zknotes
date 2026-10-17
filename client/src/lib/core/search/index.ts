/**
 * The main-thread orchestrator for the encrypted search index.
 *
 * The real MiniSearch instance lives inside the crypto SharedWorker — the plaintext tokens never
 * leave that scope. This module is only the glue:
 *   - it debounces persisting the encrypted, serialised blob into IndexedDB
 *   - it exposes the simple imperative API the rest of the app uses (addOrUpdate, remove, search…)
 *   - it settles the "load the encrypted blob from IDB, or rebuild from the items" decision at unlock
 */

import type { NotePayload } from "@zknotes/shared";
import { decryptManyItemPayloads } from "$lib/core/crypto/item-codec";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import { getDB } from "$lib/core/db";
import { extractPlainText } from "$lib/core/utils/tiptap-text";
import {
    addIndexDocsTask,
    addIndexDocTask,
    buildIndexTask,
    loadPersistedIndexTask,
    removeIndexDocTask,
    type SearchDoc,
    type SearchHit,
    searchIndexTask,
    serializeIndexTask,
} from "$lib/core/workers/crypto-rpc";
import { mergeHits, type RankedHit, rankTitles, recentItems } from "./rank";

const INDEX_KEY = "index";
const PERSIST_DEBOUNCE_MS = 1_500;

let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> | null = null;
// A pull can touch hundreds of items; suppressing the debounce while one is in flight (query "perf
// 6") turns N implicit re-arms + a full-index reserialise per item into one explicit flush at the
// end. Depth-counted so nested suspend/resume (a re-entrant pull) can't resume too early.
let suspendDepth = 0;

function markDirty() {
    dirty = true;
    if (suspendDepth > 0) {
        // A flush is owed once resumeIndexPersistenceAndFlush runs — do not let an already-armed
        // timer fire independently in the meantime.
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        return;
    }
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void flushIndex();
    }, PERSIST_DEBOUNCE_MS);
}

/**
 * Suspends the persist debounce (query "perf 6") — call before a bulk operation (a pull) that will
 * call addOrUpdateDoc/removeDoc many times, so it does not re-serialise the whole index after every
 * single item. Always pair with resumeIndexPersistenceAndFlush, in a finally block.
 */
export function suspendIndexPersistence(): void {
    suspendDepth++;
}

/** Resumes the persist debounce and flushes at once if anything changed while suspended. */
export async function resumeIndexPersistenceAndFlush(): Promise<void> {
    suspendDepth = Math.max(0, suspendDepth - 1);
    if (suspendDepth === 0) {
        await flushIndex();
    }
}

/** Force the index to be written at once if it is dirty. Call it on visibilitychange === hidden. */
export async function flushIndex(): Promise<void> {
    if (!dirty) return;
    if (persistInFlight) return persistInFlight;
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }

    persistInFlight = (async () => {
        try {
            const blob = await serializeIndexTask();
            const db = await getDB();
            if (blob.empty) {
                await db.delete("search-index", INDEX_KEY);
            } else {
                await db.put("search-index", {
                    id: INDEX_KEY,
                    ciphertext: blob.ciphertext,
                    nonce: blob.nonce,
                    ikCiphertext: blob.ikCiphertext,
                    ikNonce: blob.ikNonce,
                });
            }
            dirty = false;
        } catch (e) {
            console.error("Failed to persist search index", e);
        } finally {
            persistInFlight = null;
        }
    })();

    return persistInFlight;
}

/**
 * At unlock: try to load the encrypted index from IDB; if it is missing or corrupt, rebuild it from
 * scratch by decrypting every non-tombstone item.
 *
 * `onProgress` is emitted with the number of documents built during a rebuild, so the UI can show a
 * spinner.
 */
export async function loadOrBuildIndex(
    onProgress?: (built: number, total: number) => void,
): Promise<{ rebuilt: boolean; count: number }> {
    const db = await getDB();
    const persisted = await db.get("search-index", INDEX_KEY);

    if (persisted) {
        try {
            const { count } = await loadPersistedIndexTask({
                ciphertext: new Uint8Array(persisted.ciphertext),
                nonce: new Uint8Array(persisted.nonce),
                ikCiphertext: new Uint8Array(persisted.ikCiphertext),
                ikNonce: new Uint8Array(persisted.ikNonce),
            });
            return { rebuilt: false, count };
        } catch (e) {
            console.warn("Persisted search index unreadable — rebuilding", e);
            await db.delete("search-index", INDEX_KEY);
        }
    }

    return rebuildIndex(onProgress);
}

/**
 * Rebuilds the index from scratch by walking the IndexedDB items, decrypting each payload,
 * and extracting the plaintext. Slow on a cold start with many notes.
 */
const REBUILD_DECRYPT_CHUNK_SIZE = 200;

export async function rebuildIndex(
    onProgress?: (built: number, total: number) => void,
): Promise<{ rebuilt: true; count: number }> {
    const db = await getDB();
    const allItems = await db.getAll("items");
    const live = allItems.filter((i) => !i.deleted_at);

    const docs: SearchDoc[] = [];
    let built = 0;
    onProgress?.(0, live.length);

    // Chunked batch decrypt (query "perf 5") instead of one worker round trip per item — a cold
    // start on a large vault used to serialise ADD_ITEM_KEY+DECRYPT_PAYLOAD per item.
    for (let i = 0; i < live.length; i += REBUILD_DECRYPT_CHUNK_SIZE) {
        const chunk = live.slice(i, i + REBUILD_DECRYPT_CHUNK_SIZE);
        const byId = new Map(chunk.map((item) => [item.id, item]));
        const results = await decryptManyItemPayloads<Partial<NotePayload>>(chunk);

        for (const r of results) {
            const item = byId.get(r.id);
            if (!item || r.data === undefined) {
                console.warn(`Skipping item ${r.id} during index build`, r.error);
                continue;
            }
            const doc: SearchDoc = {
                id: item.id,
                type: item.type,
                title: r.data.title || "Untitled",
            };
            if (item.type === "note" && r.data.content) {
                doc.content = extractPlainText(r.data.content);
            }
            docs.push(doc);
        }
        built += chunk.length;
        onProgress?.(built, live.length);
    }

    const { count } = await buildIndexTask(docs);
    markDirty();
    return { rebuilt: true, count };
}

export async function addOrUpdateDoc(doc: SearchDoc): Promise<void> {
    await addIndexDocTask(doc);
    markDirty();
}

/** The batch variant of addOrUpdateDoc (query "perf 2"): N docs in ONE worker round trip. */
export async function addOrUpdateDocs(docs: SearchDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await addIndexDocsTask(docs);
    markDirty();
}

export async function removeDoc(id: string): Promise<void> {
    await removeIndexDocTask(id);
    markDirty();
}

export async function search(query: string, limit = 20): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    return searchIndexTask(q, limit);
}

/** Cancels a pending debounce — call it on logout so the just-cleared worker index is not
 * accidentally serialised as "empty" over the stored blob. */
export function cancelPendingPersist(): void {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    dirty = false;
}

/**
 * What the command palette calls.
 *
 * The title lane runs right here, over the tree items the main thread already holds decrypted — no
 * worker round trip, no index, no persistence. The content lane is the worker's MiniSearch, exactly
 * as before. An empty query lists the recently touched items instead of nothing.
 */
export async function searchItems(
    query: string,
    items: readonly DecryptedItemMeta[],
    limit = 8,
): Promise<RankedHit[]> {
    const q = query.trim();
    if (!q) return recentItems(items, limit);

    const titleHits = rankTitles(q, items, limit);
    const contentHits = await search(q, limit * 2);
    return mergeHits(titleHits, contentHits, limit);
}

export { highlightSegments } from "./fuzzy";
export { groupByType, type HitSection, type RankedHit } from "./rank";
