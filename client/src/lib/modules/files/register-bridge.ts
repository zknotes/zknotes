/**
 * Registers the modules/files implementations on core/events/file-bridge (see the description over
 * there). Called once from (app)/+layout.svelte during the bootstrap. The registration itself is cheap
 * — the heavy modules (download/cleanup/invalidation/blob-cache) stay lazy: they load only on the
 * bridge's first call, which preserves the code splitting `core` used to get from a dynamic import.
 */
import { registerFileBridge } from "$lib/core/events/file-bridge";

let inFlight: Promise<void> | null = null;
let pendingIds = new Set<string>();

async function runCleanupLoop(): Promise<void> {
    while (pendingIds.size > 0) {
        const batch = [...pendingIds];
        pendingIds = new Set();
        const { cleanupOrphanedFileRefs } = await import("./cleanup");
        try {
            await cleanupOrphanedFileRefs(batch);
        } catch (e) {
            console.error("Orphan file-ref cleanup failed:", e);
            // Do not re-throw — the while loop carries on with whatever arrived in the meantime.
        }
    }
}

export function registerFilesBridge(): void {
    // Trigger pin-orchestrator (top level executes registration of syncPinnedChunks + method decoration
    // on the core pinManager singleton). Same lazy-init pattern as other file features.
    void import("./pin-orchestrator");
    // The cross-tab files channel has to be RECEIVING in every tab from the start — a tab
    // with a note open must learn that another tab trashed or moved one of its embeds.
    void import("./file-invalidator").then((m) => m.ensureFilesBroadcastChannel());

    registerFileBridge({
        async invalidateFile(fileId) {
            const { invalidateFile } = await import("./invalidation");
            await invalidateFile(fileId);
        },
        clearBlobCache() {
            void import("./blob-cache").then((m) => m.clearBlobCache());
        },
        cancelPendingTrash() {
            void import("./pending-trash").then((m) => m.pendingTrashManager.cancelAll());
        },
        async getFilePayload(fileId) {
            const { getFilePayload } = await import("./download");
            return getFilePayload(fileId);
        },
        async moveFileEmbedBetweenNotes(fileId, fromNoteId, toNoteId, fileName, mime) {
            const { moveFileEmbedBetweenNotes } = await import("./cleanup");
            await moveFileEmbedBetweenNotes(fileId, fromNoteId, toNoteId, fileName, mime);
        },
        async isPinnedChunkSet(chunkSetId) {
            const { isPinnedChunkSet } = await import("./pin-orchestrator");
            return isPinnedChunkSet(chunkSetId);
        },
        async getPinnedChunkSetIds() {
            const { buildPinnedChunkSetIds } = await import("./pin-orchestrator");
            return buildPinnedChunkSetIds();
        },
        async cleanupOrphanedFileRefs(fileIds) {
            for (const id of fileIds) pendingIds.add(id);
            if (!inFlight) {
                inFlight = runCleanupLoop().finally(() => {
                    inFlight = null;
                });
            }
            return inFlight.then(() => []);
        },
        async stageRestoreUpload(args) {
            const { startTrackedUpload } = await import("./upload-manager");
            return startTrackedUpload({
                file: args.file,
                parentId: args.parentId,
                name: args.name,
                uploadOpts: {
                    itemId: args.itemId,
                    restoreSessionId: args.restoreSessionId,
                    stageOnly: true,
                    ...(args.sortOrder ? { sortOrder: args.sortOrder } : {}),
                    ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
                    ...(args.version !== undefined ? { version: args.version } : {}),
                    ...(args.description ? { description: args.description } : {}),
                    ...(args.onProgress ? { onProgress: args.onProgress } : {}),
                },
            });
        },
    });
}
