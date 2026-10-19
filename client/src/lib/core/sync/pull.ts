// The pull — a paginated delta sync from the server. Each page's changes and hard deletes are merged
// into IndexedDB (a dirty local row is left for its push to reconcile; a purged one with unsynced
// changes becomes a conflict copy first), and a user switch or a restore replaces the local vault by
// mark-and-sweep once the whole pull has landed.
import { type AnyItemPayload, createsCycle, ITEM_LIMITS, SYNC_LIMITS } from "@zknotes/shared";
import { ApiError, type PullDelta, pullPage } from "$lib/core/api";
import { APP_EVENTS } from "$lib/core/constants/events";
import { decryptManyItemPayloads } from "$lib/core/crypto/item-codec";
import { getDB, getWatermark, setWatermark } from "$lib/core/db";
import { fileBridge } from "$lib/core/events/file-bridge";
import { evictChunkSet, resetChunkCacheCounters } from "$lib/core/files/chunk-loader";
import {
    addOrUpdateDocs,
    removeDoc,
    resumeIndexPersistenceAndFlush,
    suspendIndexPersistence,
} from "$lib/core/search";
import { toSearchDoc } from "$lib/core/search/doc";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { SECOND_MS } from "$lib/core/utils/duration";
import { clearRestoreUiKeys } from "$lib/core/utils/clear-vault-ui-keys";
import { loadPersisted, rawStringSerde, STORAGE_KEYS } from "$lib/core/utils/persisted";
import type { SearchDoc } from "$lib/core/workers/crypto-rpc";
import { createConflictCopyForItem } from "./conflict";
import { enqueueMutation } from "./outbox";
import { syncStore } from "./store.svelte";
import { isSyncLockHeld, withSyncLock } from "./sync-lock";
import { hasLocalChunkSetRef, wireToLocalItem } from "./wire";

// Do not read ITEM_LIMITS at top level: the production Vite chunk (engine ↔ the @zknotes/shared
// barrel) is circular, because topoSortByParent and createsCycle ended up in the engine chunk.
// Top-level access sees undefined and brings down the whole boot (the PWA preview 500).
function maxPullPages(): number {
    return ITEM_LIMITS.MAX_ITEMS_COUNT * 2 + 8;
}

async function fetchPullPage(opts: { since: number; cursor?: string | null }): Promise<PullDelta> {
    let delay = SECOND_MS;
    for (let attempt = 0; ; attempt++) {
        try {
            return await pullPage({
                since: opts.since,
                cursor: opts.cursor,
                limit: SYNC_LIMITS.PULL_PAGE_SIZE,
            });
        } catch (e) {
            const retryable = e instanceof ApiError && e.status === 429;
            if (!retryable || attempt >= 10) throw e;
            // Under vitest we do not wait out the real backoff — a test proves it resumes from the
            // same cursor.
            const wait = import.meta.env.VITEST ? 0 : delay;
            await new Promise((r) => setTimeout(r, wait));
            delay = Math.min(delay * 2, 30 * SECOND_MS);
        }
    }
}

export async function pullAndMerge(opts?: {
    /**
     * Restore's phase 5: watermark 0, then a wipe, then apply. It leaves the `pendingClear` flag
     * alone.
     */
    replaceLocal?: boolean;
}): Promise<{ itemCount: number; changedIds: string[] }> {
    const replaceLocal = opts?.replaceLocal === true;
    const isPendingClear =
        !replaceLocal &&
        loadPersisted(STORAGE_KEYS.pendingClearForUser, "false", rawStringSerde) === "true";

    // A user-switch / restore wipe must not race another tab's drain, and must not be skipped
    // (scheduler uses ifAvailable). Re-enter once the blocking lock is held.
    if ((replaceLocal || isPendingClear) && !isSyncLockHeld()) {
        let result: { itemCount: number; changedIds: string[] } = { itemCount: 0, changedIds: [] };
        await withSyncLock(async () => {
            result = await pullAndMerge(opts);
        });
        return result;
    }

    // If a different user has just signed in, the old watermark must not be sent (we would lose history).
    const watermark = isPendingClear || replaceLocal ? 0 : await getWatermark();

    const db = await getDB();
    // IDs present before this pull. A note created while pages are still arriving is not in this
    // set and must survive the mark-and-sweep (otherwise the first sync after an account switch
    // deletes it — the server never saw it, so it is not in seenIds).
    const prePullIds =
        isPendingClear || replaceLocal
            ? new Set((await db.getAll("items")).map((item) => item.id))
            : null;
    // Track which IDs the pull actually wrote — the scheduler passes them to the layout, which
    // invalidates the matching note queries so the editor shows the new content without a reload.
    const changedIds: string[] = [];
    const purgedFileIds = new Set<string>();
    const seenIds = new Set<string>();
    let cursor: string | null | undefined;
    let serverTime: number | undefined;
    let itemCount = 0;
    let pages = 0;

    // Suppress the search index's persist debounce for the whole pull — a page can
    // touch hundreds of items, and without this every one of them would re-arm a full-index
    // reserialise instead of one explicit flush once the pull is done. Every exit path below
    // (success, network-error skip, and the replaceLocal rethrow) resumes it.
    suspendIndexPersistence();

    try {
        do {
            const data = await fetchPullPage({ since: watermark, cursor });
            if (serverTime === undefined) serverTime = data.server_time;
            const serverItems = data.items;
            // The delta pull's second list: hard-delete entries from sync_deleted_log.
            // A deletion is an ordinary delta event — it does not depend on whether the items tombstone is still alive.
            const deletedEntries = data.deleted ?? [];
            itemCount += serverItems.length;
            pages += 1;
            if (pages > maxPullPages()) {
                throw new Error("pull pagination exceeded max pages");
            }

            // One local-items snapshot per page, shared by every chunk-set
            // reference check below instead of a fresh getAll("items") per purged file. It goes
            // stale as this page's own loops delete/store rows, which only makes evictChunkSet
            // conservative (a chunk set some rare mid-page deletion also freed stays cached until
            // the next check) — never wrong in the data-loss direction.
            const localItemsSnapshot = await db.getAll("items");

            for (const entry of deletedEntries) {
                const local = await db.get("items", entry.id);
                if (!local) continue;

                // Unpushed local changes must not vanish silently. Fail closed: if the copy
                // fails, do NOT delete the original (that would be data loss). The copy is pushed as a
                // new item; the original disappears locally only after the copy succeeds (the server
                // has purged that id anyway).
                // A locally tombstoned row (purged_at) has nothing worth preserving even when a
                // stale `dirty` is still on it — a copy of it would resurrect a permanently deleted
                // item as a live "[Conflict …]" note.
                if (local.dirty && local.purged_at == null) {
                    try {
                        const { item: conflictCopy, title } =
                            await createConflictCopyForItem(local);
                        await db.put("items", conflictCopy);
                        await enqueueMutation(conflictCopy.id, "upsert");
                        conflictStore.add({
                            id: conflictCopy.id,
                            title,
                            type: local.type,
                            at: Math.floor(Date.now() / 1000),
                        });
                    } catch (e) {
                        console.error(
                            "Failed to create conflict copy for purged item",
                            local.id,
                            e,
                        );
                        // Keep the dirty original and its mutation; the next sync retries the copy.
                        // Why the watermark is not held back: setWatermark runs at the end of the whole
                        // pull — reprocessing the deleted log may repeat, and the copy retry depends on
                        // the original staying put.
                        if (!local.sync_error) {
                            local.sync_error = "pending_purge_conflict";
                            await db.put("items", local);
                        }
                        continue;
                    }
                }

                await db.delete("items", entry.id);
                void removeDoc(entry.id).catch(() => {});
                if (local.type === "file") {
                    purgedFileIds.add(entry.id);
                    void fileBridge.invalidateFile(entry.id).catch(() => {});
                    // Do not evict the chunk set while a conflict copy still references it
                    // (shared).
                    if (local.chunk_set_id) {
                        const stillShared = hasLocalChunkSetRef(
                            localItemsSnapshot,
                            local.chunk_set_id,
                            entry.id,
                        );
                        if (!stillShared) void evictChunkSet(local.chunk_set_id).catch(() => {});
                    }
                }
            }

            // Decrypt every non-tombstoned, non-trashed item in this page in ONE worker round trip
            // instead of one per item — must finish before any IDB transaction
            // opens (a worker await inside an open tx auto-commits it, see below). The filter
            // mirrors the old hydrateConflictMarker guard exactly.
            const pageItems = serverItems.map((raw) => wireToLocalItem(raw));
            const decryptCandidates = pageItems.filter(
                (it) => !it.deleted_at && !it.purged_at && it.encrypted_payload && it.payload_nonce,
            );
            const decryptResults =
                decryptCandidates.length > 0
                    ? await decryptManyItemPayloads<AnyItemPayload>(decryptCandidates)
                    : [];
            const payloadById = new Map<string, AnyItemPayload>();
            for (const r of decryptResults) {
                if (r.data !== undefined) payloadById.set(r.id, r.data);
            }
            // Mirror payload.conflict_of onto the plaintext column (the old hydrateConflictMarker's
            // side effect) so getTreeItems and the Conflict Inbox see it without a flow of their own.
            for (const it of pageItems) {
                const p = payloadById.get(it.id);
                if (p?.conflict_of && !it.conflict_of) it.conflict_of = p.conflict_of;
            }
            // Collected across the whole page and sent as ONE ADD_INDEX_DOCS message afterwards
            // instead of one ADD_INDEX_DOC postMessage per stored item.
            const indexDocs: SearchDoc[] = [];

            for (const serverItem of pageItems) {
                seenIds.add(serverItem.id);

                // Hard-delete tombstone = `purged_at` (DELETED), NE `deleted_at`. Synced trash (7b):
                // `deleted_at` without purged_at means TRASHED — an ordinary state that is applied
                // (the item stays, only in Trash); nothing is deleted locally.
                if (serverItem.purged_at) {
                    // Separate db operations (NOT one long-lived transaction): the conflict copy does
                    // its crypto through the worker (an async yield), and an IndexedDB transaction would
                    // auto-commit meanwhile, so store.put/delete would throw TransactionInactiveError.
                    // The same pattern as the deletedEntries branch.
                    const local = await db.get("items", serverItem.id);
                    // The copy BEFORE the evict — otherwise the local ciphertext is lost before the
                    // copy succeeds.
                    // Same rule as the deletedEntries branch: a local tombstone is never copied.
                    if (local?.dirty && local.purged_at == null) {
                        try {
                            const { item: conflictCopy, title } =
                                await createConflictCopyForItem(local);
                            await db.put("items", conflictCopy);
                            await enqueueMutation(conflictCopy.id, "upsert");
                            conflictStore.add({
                                id: conflictCopy.id,
                                title,
                                type: local.type,
                                at: Math.floor(Date.now() / 1000),
                            });
                        } catch (e) {
                            console.error(
                                "Failed to create conflict copy for tombstone",
                                local.id,
                                e,
                            );
                            if (!local.sync_error) {
                                local.sync_error = "pending_purge_conflict";
                                await db.put("items", local);
                            }
                            continue;
                        }
                    }
                    if (local?.type === "file") {
                        purgedFileIds.add(serverItem.id);
                        void fileBridge.invalidateFile(serverItem.id).catch(() => {});
                        if (local.chunk_set_id) {
                            const stillShared = hasLocalChunkSetRef(
                                localItemsSnapshot,
                                local.chunk_set_id,
                                serverItem.id,
                            );
                            if (!stillShared)
                                void evictChunkSet(local.chunk_set_id).catch(() => {});
                        }
                    }
                    await db.delete("items", serverItem.id);
                    void removeDoc(serverItem.id).catch(() => {});
                    continue;
                }

                // (7b) Trash is now SYNCED: the server is authoritative for `deleted_at`. There is no
                // "preserve local deleted_at" hack any more — the pull applies the server's state
                // normally (cross-device trash/restore). A pending local trash is protected by the
                // `dirty` flag (deleteItem now sets dirty=true) → the dirty branch below does not let
                // the server overwrite it before the push is acknowledged.

                // CRYPTO ALREADY DONE ABOVE (batched, before this loop and before any IDB
                // transaction) — no per-item worker round trip here.
                const payload = payloadById.get(serverItem.id) ?? null;

                const tx = db.transaction("items", "readwrite");
                const store = tx.objectStore("items");
                const local = await store.get(serverItem.id);

                // A pending local purge (permanentDeleteItem / the FileService.hardDelete tombstone):
                // the server still has a live row, but the user deleted it permanently and the delete is
                // waiting for its acknowledgement. Do not resurrect it and do not overwrite the local
                // purge state. The tombstone is cleared only once the server confirms the purge
                // (the serverItem.purged_at branch above, or sync_deleted_log).
                if (local?.purged_at) {
                    await tx.done;
                    continue;
                }

                let stored = false;
                const cycleBreakIds: string[] = [];
                if (!local) {
                    // A new item from the server — store it (serverItem already carries the mirrored conflict_of, if any)
                    await store.put(serverItem);
                    stored = true;
                } else if (!local.dirty) {
                    // Local is clean — the server wins if it is newer
                    if (serverItem.version > local.version) {
                        if (
                            serverItem.type === "folder" &&
                            serverItem.parent_id &&
                            serverItem.parent_id !== local.parent_id
                        ) {
                            const all = await store.getAll();
                            const parentMap = new Map(
                                all.map((row) => [row.id, row.parent_id ?? null]),
                            );
                            parentMap.set(serverItem.id, serverItem.parent_id);
                            if (createsCycle(serverItem.id, serverItem.parent_id, parentMap)) {
                                for (const other of all) {
                                    if (
                                        other.id === serverItem.id ||
                                        !other.dirty ||
                                        other.type !== "folder" ||
                                        other.parent_id == null
                                    ) {
                                        continue;
                                    }
                                    other.parent_id = null;
                                    other.dirty = true;
                                    other.localRev = (other.localRev || 0) + 1;
                                    await store.put(other);
                                    cycleBreakIds.push(other.id);
                                }
                            }
                        }
                        // Carry localRev forward (bumped), never reset it — see applyConflict.
                        await store.put({
                            ...serverItem,
                            localRev: (local.localRev ?? 0) + 1,
                        });
                        stored = true;
                    }
                }
                // else: dirty locally — a pending push; reconcile on the push (409 → a conflict copy), not on the pull.
                await tx.done;
                for (const id of cycleBreakIds) {
                    await enqueueMutation(id, "upsert");
                }

                if (stored) {
                    changedIds.push(serverItem.id);
                    if (serverItem.deleted_at || serverItem.purged_at) {
                        void removeDoc(serverItem.id).catch(() => {});
                    } else if (
                        serverItem.encrypted_payload &&
                        serverItem.payload_nonce &&
                        payload
                    ) {
                        indexDocs.push(toSearchDoc(serverItem, payload));
                    }
                    // A new conflict item from another device → surface it in the inbox at once.
                    if (serverItem.conflict_of && !local) {
                        conflictStore.add({
                            id: serverItem.id,
                            title: ((payload?.name || payload?.title) ?? "Untitled") as string,
                            type: serverItem.type,
                            at: Math.floor(Date.now() / 1000),
                        });
                    }
                }
            }

            if (indexDocs.length > 0) {
                void addOrUpdateDocs(indexDocs).catch((e) => {
                    console.warn("Failed to index a page of synced items", e);
                });
            }

            cursor = data.next_cursor ?? null;
        } while (cursor);
    } catch (e) {
        // Restore phase 5 must not wipe an empty vault if the pull fails.
        if (replaceLocal) {
            await resumeIndexPersistenceAndFlush();
            throw e;
        }
        // A network error — skip this pull. Partially applied pages stay, and the watermark does not
        // move. Return the IDs already written so the UI can invalidate them instead of
        // sitting on a stale tree until the next 5-minute interval.
        await resumeIndexPersistenceAndFlush();
        return { itemCount, changedIds };
    }

    if (isPendingClear || replaceLocal) {
        // Mark and sweep: the database is not cleared before its replacement is durable.
        // The pages were written as they arrived; now delete locally whatever the server did not send.
        // Restore phase 5 shares this block with the pendingClear wipe — the only source of truth
        // for a wipe.
        // Skip rows that did not exist when the pull started — those were created during the pull
        // (a new note while the first post-login sync is still paging) and must be pushed, not wiped.
        const locals = await db.getAll("items");
        for (const local of locals) {
            if (seenIds.has(local.id)) continue;
            if (prePullIds && !prePullIds.has(local.id)) continue;
            if (local.type === "file") {
                purgedFileIds.add(local.id);
                void fileBridge.invalidateFile(local.id).catch(() => {});
                if (local.chunk_set_id) {
                    // `locals` is already a fresh, current snapshot — reuse it directly.
                    const stillShared = hasLocalChunkSetRef(locals, local.chunk_set_id, local.id);
                    if (!stillShared) void evictChunkSet(local.chunk_set_id).catch(() => {});
                }
            }
            await db.delete("items", local.id);
            await db.delete("mutation-queue", local.id);
            void removeDoc(local.id).catch(() => {});
        }
        try {
            const { clearAllPendingUploadsOnLogout } = await import(
                "$lib/modules/files/upload-manager"
            );
            await clearAllPendingUploadsOnLogout().catch(() => {});
        } catch {
            // A test or demo environment with no upload manager — the IDB clear below still empties the stores.
        }
        await db.clear("pending-uploads");
        await db.clear("upload-chunks");
        await db.clear("file-chunks");
        resetChunkCacheCounters();
        // search-index and metadata are deliberately NOT cleared here: the page loop above already
        // reindexes every item received (addOrUpdateDocs per page), so a blanket clear after the loop
        // would wipe the indexes just written. A known, accepted remainder: index entries for items
        // the server no longer returns stay stale until that item is next touched (the pendingClear
        // wipe shares this).
        if (isPendingClear) localStorage.removeItem(STORAGE_KEYS.pendingClearForUser);
        // The same list of UI keys as restore phase 5 (a core util, not the export module).
        clearRestoreUiKeys();
    }

    if (serverTime !== undefined) await setWatermark(serverTime);
    syncStore.markSyncSuccess();

    // Start fetching the pinned files if this pull added or changed any of them.
    // Fired without an await so it does not slow down telling the UI the pull has finished.
    fileBridge.syncPinnedChunks?.().catch((e) => {
        console.error("Failed to sync pinned chunks after pull:", e);
    });

    if (purgedFileIds.size > 0) {
        void fileBridge.cleanupOrphanedFileRefs([...purgedFileIds]).catch((e) => {
            console.error("Orphan file-ref cleanup failed:", e);
        });
    }

    // The first pull on a new device, or phase 5 — tell the UI to drop "Vault is waiting".
    if ((isPendingClear || replaceLocal) && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
    }

    await resumeIndexPersistenceAndFlush();
    return { itemCount, changedIds };
}
