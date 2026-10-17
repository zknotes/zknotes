// FileService — the ONLY orchestrator of the file (Axis 2) lifecycle.
//
// The boundary of responsibility: the CORE = the file lifecycle. Files have no descendants (1:1), so
// the standalone file operations (trash/restore/hardDelete) have NO cascade — FileService performs
// them directly against IDB behind a `FileLifecycle` guard. The "delete a note → its files" cascade is
// run by `ItemService` (the cascade's owner), because notes and folders do have descendants.
// FileService touches no note HTML (an embed is embed-html) and imports neither QueryClient nor Svelte
// (the invalidation is done by the bridge, through `filesChanged`).
//
// rename and crop still delegate to the shared infrastructure (reencrypt / replaceFileContent) —
// that infrastructure has not been moved into this module yet.

import { type AnyItemPayload, FILE_LIMITS } from "@zknotes/shared";
import { pushBatch } from "$lib/core/api";
import { APP_EVENTS } from "$lib/core/constants/events";
import { getDB, type LocalItem } from "$lib/core/db";
import { evictChunkSet } from "$lib/core/files/chunk-loader";
import { removeDoc } from "$lib/core/search";
import { ItemService } from "$lib/core/services/item-service";
import { applyRefusedDeletes, enqueueMutation, pushItem } from "$lib/core/sync";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";
import { emitFilesChanged, emitNotesChanged } from "./files-changed-bus";
import { invalidateFile } from "./invalidation";
import { pendingTrashManager } from "./pending-trash";
import type { UploadProgress } from "./upload";

export type FileRestoreResult = {
    appendedToNoteId: string;
    noteTitle: string;
};

/** Kick the sync engine (the scheduler listens) to drain the mutation queue at once — parity with ItemService. */
function kickSync(): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
    }
}

// biome-ignore lint/complexity/noStaticOnlyClass: the same convention as ItemService.
export class FileService {
    /**
     * The axis 1 → axis 2 handoff: the ONLY point where an upload becomes a persisted READY item. It takes
     * a fully prepared (encrypted) `LocalItem` from `FileUploader` (upload.ts), writes it,
     * enqueues the sync upsert and emits `filesChanged` (the bridge invalidates the queries).
     */
    static async createFromUpload(item: LocalItem): Promise<void> {
        const db = await getDB();
        await db.put("items", item);
        pushItem(item).catch(() => enqueueMutation(item.id, "upsert"));
        emitFilesChanged([item.id]);
        kickSync();
    }

    /**
     * The image's intrinsic dimensions from the payload. The paths that insert an embed (restore,
     * move, link) use them so the node carries `data-w`/`data-h` at once and does not jump on its
     * FIRST render — otherwise the self-heal writes them only after `img.load`, which comes after
     * decryption.
     */
    static async #imageDims(fileId: string): Promise<{ width?: number; height?: number }> {
        const meta = await ItemService.getDecryptedItem(fileId).catch(() => null);
        const p = meta?.payload as AnyItemPayload | undefined;
        const width = typeof p?.width === "number" ? p.width : undefined;
        const height = typeof p?.height === "number" ? p.height : undefined;
        return { width, height };
    }

    /** READY → TRASHED (delete attachment). Synced (7b): a trash is an ordinary mutation (push). */
    static async trash(fileId: string): Promise<void> {
        const db = await getDB();
        const item = await db.get("items", fileId);
        if (item?.type !== "file") return; // GONE / not a file → a no-op
        if (!FileLifecycle.can(FileLifecycle.stateOf(item), "trash")) return; // already trashed → a no-op

        // Synced trash (7b): a trash is a normal mutation → markDirtyAndPush propagates the trash state.
        item.deleted_at = Math.floor(Date.now() / 1000);
        await ItemService.markDirtyAndPush(item);

        const { removeFileRefsEverywhere } = await import("./cleanup");
        const stripped = await removeFileRefsEverywhere([fileId]);

        void removeDoc(fileId).catch(() => {});
        void invalidateFile(fileId).catch(() => {});
        emitFilesChanged([fileId]);
        if (stripped.length > 0) emitNotesChanged(stripped);
        // Cross-tab: the other tabs drop the live node and reconcile their save baselines.
        const { notifyFileTrashed } = await import("./file-invalidator");
        notifyFileTrashed(fileId);
        kickSync();
    }

    /** TRASHED → READY. The owner-READY invariant: if the owning note is gone or deleted → put it back at the root. */
    static async restore(fileId: string): Promise<FileRestoreResult | undefined> {
        const db = await getDB();
        const item = await db.get("items", fileId);
        if (item?.type !== "file") return;
        if (!FileLifecycle.can(FileLifecycle.stateOf(item), "restore")) return; // not trashed → a no-op

        let parentId = item.parent_id;
        if (parentId) {
            const owner = await db.get("items", parentId);
            if (!owner || owner.deleted_at) parentId = null; // the limbo guard
        }

        item.parent_id = parentId;
        item.deleted_at = undefined;
        await ItemService.markDirtyAndPush(item);

        let restoreResult: FileRestoreResult | undefined;
        if (parentId) {
            const { noteContainsFileEmbed } = await import("./cleanup");
            const hasEmbed = await noteContainsFileEmbed(parentId, fileId);
            if (!hasEmbed) {
                const fileMeta = await ItemService.getDecryptedItem(fileId);
                const noteMeta = await ItemService.getDecryptedItem(parentId);
                const filePayload = fileMeta?.payload as AnyItemPayload | undefined;
                const fileName =
                    (filePayload?.name as string | undefined) || filePayload?.title || "File";
                const mime = filePayload?.mime as string | undefined;
                await ItemService.appendFileToNote(parentId, fileId, fileName, mime, {
                    width: typeof filePayload?.width === "number" ? filePayload.width : undefined,
                    height:
                        typeof filePayload?.height === "number" ? filePayload.height : undefined,
                });
                emitNotesChanged([parentId]);
                // Cross-tab: an editor open on the owner note over there reloads or appends.
                const { notifyFileRestored } = await import("./file-invalidator");
                notifyFileRestored(fileId, parentId);
                restoreResult = {
                    appendedToNoteId: parentId,
                    noteTitle: (noteMeta?.payload?.title as string | undefined) || "Untitled",
                };
            }
        }

        void invalidateFile(fileId).catch(() => {});
        emitFilesChanged([fileId]);
        kickSync();
        return restoreResult;
    }

    /** TRASHED → DELETED (permanent / empty trash). Files have no descendants → no cascade. */
    static async hardDelete(fileIds: string | string[]): Promise<void> {
        const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
        if (ids.length === 0) return;

        const db = await getDB();
        const now = Math.floor(Date.now() / 1000);
        const purged: string[] = [];
        // A version-aware delete: the server purges only when the version matches.
        const deleteEntries: { id: string; version: number }[] = [];

        // One IDB transaction for every tombstone write: two parallel hardDelete calls (a double click,
        // or two tabs on the Trash page) can otherwise both read the same item BEFORE the first sets
        // purged_at (every db.get/db.put auto-commits separately) and both add it to deleteEntries. The
        // purged_at guard below makes this idempotent even within the same transaction.
        const tx = db.transaction("items", "readwrite");
        const store = tx.objectStore("items");
        for (const id of ids) {
            const item = await store.get(id);
            if (!item) continue; // GONE → an idempotent skip
            // FileLifecycle approves the transition, not the service. It covers both "already
            // tombstoned" (DELETED has no outgoing transitions) and "still READY" (hardDelete is
            // legal only from TRASHED). A disallowed transition is a no-op, not a throw — the API
            // layer is idempotent.
            if (!FileLifecycle.can(FileLifecycle.stateOf(item), "hardDelete")) continue;
            // Tombstone locally (purged_at); do NOT delete the row before the server's
            // acknowledgement: otherwise an offline pushBatch failure plus the next pull re-insert
            // the file through the `!local` branch. The pull skips locals with purged_at; the row
            // is deleted only once the server confirms the purge (the success below, or a
            // delete-mutation drain).
            item.purged_at = now;
            // The same rule as ItemService.permanentDeleteItem: a tombstone keeps no `dirty` — the
            // pull's tombstone branches would otherwise copy it into a live "[Conflict …]" file.
            item.dirty = false;
            item.sync_error = undefined;
            await store.put(item);
            purged.push(id);
            deleteEntries.push({ id, version: item.version });
            void removeDoc(id).catch(() => {});
            void invalidateFile(id).catch(() => {});
            // Permanently deleted → drop the local ciphertext cache.
            if (item.chunk_set_id) void evictChunkSet(item.chunk_set_id).catch(() => {});
        }
        await tx.done;
        if (purged.length === 0) return;

        // The embed strip and the local row deletion wait for the server's answer. A version-aware
        // purge can be REFUSED (the file was restored or edited on another device meanwhile): the
        // file is then alive on the server, and stripping its embed out of every note beforehand
        // would leave a live file with no owner embed anywhere, pushed to every device. Offline, the
        // drain strips once the server acknowledges (push.ts drainDeleteMutations).
        const acked: string[] = [];
        const refused = new Set<string>();
        try {
            for (let i = 0; i < deleteEntries.length; i += FILE_LIMITS.MAX_BATCH_OPS) {
                const chunk = deleteEntries.slice(i, i + FILE_LIMITS.MAX_BATCH_OPS);
                const result = await pushBatch([], chunk);
                // Refused → the server's live row replaces the local tombstone and any queued delete
                // for it is dropped (otherwise the next drain would purge with the matching version).
                await applyRefusedDeletes(result.conflicts);
                for (const c of result.conflicts) refused.add(c.id);
                for (const entry of chunk) {
                    if (!refused.has(entry.id)) acked.push(entry.id);
                }
            }
            // The server confirmed the purge → drop the local tombstone rows.
            for (const id of acked) await db.delete("items", id);
        } catch {
            // Offline → the tombstone stays; the delete mutation drains and removes the row after the ack.
            for (const id of purged) {
                if (!acked.includes(id) && !refused.has(id)) await enqueueMutation(id, "delete");
            }
        }
        if (acked.length > 0) {
            const { cleanupOrphanedFileRefs } = await import("./cleanup");
            await cleanupOrphanedFileRefs(acked);
        }
        emitFilesChanged(purged);
        kickSync();
    }

    /**
     * A metadata update (name/description) — the file-specific logic now lives HERE (previously
     * ItemService.updateFileMeta). It uses the shared payload primitive `reencryptAndSave` (decrypt →
     * set the fields → encrypt → reindex → push); it reindexes by name plus description (searchable).
     */
    static async rename(
        fileId: string,
        changes: { name?: string; description?: string },
    ): Promise<void> {
        // A rename is a READY-only mutation (`FileAction`), so it goes through the same guard as
        // trash/restore/hardDelete/crop. A disallowed transition is a no-op, not a throw.
        const db = await getDB();
        const existing = await db.get("items", fileId);
        if (existing?.type !== "file") return;
        if (!FileLifecycle.can(FileLifecycle.stateOf(existing), "rename")) return;

        let nameChanged = false;
        await ItemService.reencryptAndSave(
            fileId,
            (p) => {
                // The spread preserves every existing payload field (kind, chunkSetId, chunks, mime, size…).
                const next = { ...p };
                if (changes.name !== undefined) {
                    if (changes.name !== (p.name as string | undefined)) nameChanged = true;
                    next.name = changes.name;
                }
                if (changes.description !== undefined) next.description = changes.description;
                return next;
            },
            {
                required: true,
                reindex: (payload, item) => ({
                    id: fileId,
                    type: item.type,
                    title: (payload.name as string) || "Untitled",
                    content: (payload.description as string) || undefined,
                }),
            },
        );

        // A NodeView reload is needed only when the name changes (the alt attribute on the PM node).
        // A description-only change alters neither the blob nor the alt — a notification would cause a
        // needless re-decrypt and make the image flicker in the editor.
        if (nameChanged) {
            const { notifyFileInvalidated } = await import("./file-invalidator");
            notifyFileInvalidated(fileId);
        }
        emitFilesChanged([fileId]);
        kickSync();
    }

    /**
     * Moves a file to another note: a reparent (the owner note) plus moving the embed (stripped from
     * every note → appended to the destination). The orchestration used to live in
     * FileDetailPanel.onMoveToNote and is now here (the UI component no longer touches ItemService or
     * the cleanup). It delegates the content operations to embed-html
     * (cleanup) and ItemService.appendFileToNote; the invalidation is done by the bridge, on the emit.
     */
    static async move(
        fileId: string,
        toNoteId: string,
        fileTitle: string,
        mime?: string,
    ): Promise<void> {
        // A move is READY-only. The guard comes BEFORE the pending-trash cancel, so the state is
        // not changed for an operation we are going to refuse anyway.
        const db = await getDB();
        const existing = await db.get("items", fileId);
        if (existing?.type !== "file") return;
        if (!FileLifecycle.can(FileLifecycle.stateOf(existing), "move")) return;

        if (pendingTrashManager.isPending(fileId)) {
            pendingTrashManager.cancel(fileId);
        }
        // Tell the open editor to remove the live encFile node first (best effort).
        if (typeof document !== "undefined") {
            document.dispatchEvent(
                new CustomEvent(APP_EVENTS.encfileDelete, {
                    detail: { fileId, silent: true },
                }),
            );
        }
        // A crash-safe order (1:1 owner/embed):
        // 1) append to the target BEFORE anything else — if that fails, the old parent and embed are untouched
        // 2) reparent — the blob is not copied; parent_id = the destination
        // 3) strip from every other note — if that fails after 1–2, the file is in the target with its embed
        //    (the old embed stays until the next strip or self-heal; better than parent=B with no embed)
        const moveDims = await FileService.#imageDims(fileId);
        await ItemService.appendFileToNote(toNoteId, fileId, fileTitle, mime, moveDims);
        await ItemService.updateParent(fileId, toNoteId);
        const { removeFileRefsEverywhere } = await import("./cleanup");
        const stripped = await removeFileRefsEverywhere([fileId], {
            excludeNoteIds: [toNoteId],
        });
        emitFilesChanged([fileId]);
        emitNotesChanged([...new Set([...stripped, toNoteId])]);
        // Cross-tab: a silent strip in the source editors plus a note query invalidation at the destination.
        const { notifyFileMoved } = await import("./file-invalidator");
        notifyFileMoved(fileId, toNoteId);
        kickSync();
    }

    /** A legacy orphan: set the owner note and add the embed (with no strip). */
    static async linkToNote(
        fileId: string,
        toNoteId: string,
        fileTitle: string,
        mime?: string,
    ): Promise<void> {
        const linkDims = await FileService.#imageDims(fileId);
        await ItemService.updateParent(fileId, toNoteId);
        await ItemService.appendFileToNote(toNoteId, fileId, fileTitle, mime, linkDims);
        emitFilesChanged([fileId]);
        emitNotesChanged([toNoteId]);
        kickSync();
    }

    /** An in-place content change (crop/replace) — the same id and Item Key, a new blob. READY only. */
    static async crop(
        fileId: string,
        file: File,
        onProgress?: (p: UploadProgress) => void,
    ): Promise<void> {
        // A crop is a READY-only mutation. Without this guard a crop on a TRASHED/DELETED file
        // uploads a new chunk set that nobody references (an orphan blob waiting for GC).
        const db = await getDB();
        const item = await db.get("items", fileId);
        if (item?.type !== "file") return;
        if (!FileLifecycle.can(FileLifecycle.stateOf(item), "crop")) return;

        const { replaceFileContent } = await import("./upload");
        await replaceFileContent(fileId, file, { onProgress });
        const { invalidate } = await import("./blob-cache");
        invalidate(fileId);
        emitFilesChanged([fileId]);
        kickSync();
    }
}
