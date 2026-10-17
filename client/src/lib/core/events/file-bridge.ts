/**
 * Inverting the core ↔ modules/files dependency. Parts of core/* (the sync engine, the streaming SW bridge,
 * the session teardown, tree drag-and-drop) need behaviour from modules/files, but the golden rule
 * of imports forbids the direction core → modules. So modules/files REGISTERS its implementations
 * here during the bootstrap (see modules/files/register-bridge.ts, called from (app)/+layout.svelte),
 * and core calls them through this bridge. The direction is thereby inverted into the permitted
 * modules → core.
 *
 * The types are core's own or from @zknotes/shared — the bridge imports NOTHING from modules/*.
 * Until an implementation is registered, the calls are safe no-ops (fire-and-forget) or
 * return null (getFilePayload). That is enough: the registration happens when the (app) layout
 * mounts, before any user action that uses the bridge.
 */
import type { EncryptedItem, FilePayload } from "@zknotes/shared";

export interface FileBridge {
    /** Clears the blob cache and tells the encFile NodeViews the file no longer exists. */
    invalidateFile(fileId: string): Promise<void>;
    /** Revokes every blob URL (a session teardown / logout). */
    clearBlobCache(): void;
    /**
     * Cancels every scheduled pending-trash timer (a session teardown or logout).
     * Without this, a scheduled `setTimeout` fires AFTER the sign-out and calls FileService.trash()
     * against a locked vault.
     */
    cancelPendingTrash(): void;
    /** Fetches a file's decrypted payload (the streaming SW bridge). */
    getFilePayload(fileId: string): Promise<FilePayload | null>;
    /** Moves a file embed from one note to another (dragging a file onto a note in the tree). */
    moveFileEmbedBetweenNotes(
        fileId: string,
        fromNoteId: string,
        toNoteId: string,
        fileName: string,
        mime?: string,
    ): Promise<void>;
    /** Starts the background sync for every pinned file (after a pull or a pin action). */
    syncPinnedChunks?: () => Promise<void>;
    /** True when the given chunkSetId belongs to any pinned file. */
    isPinnedChunkSet?: (chunkSetId: string) => Promise<boolean>;
    /**
     * The chunk_set_id of every currently-pinned file, in one pass — lets a
     * multi-candidate caller (chunk-loader's cache eviction) check membership in a Set instead of
     * calling isPinnedChunkSet (a full recomputation) once per candidate.
     */
    getPinnedChunkSetIds?: () => Promise<Set<string>>;
    /** Removes the encFile references to fileIds from EVERY note (best-effort, an orphan cleanup after a purge/tombstone). */
    cleanupOrphanedFileRefs(fileIds: string[]): Promise<string[]>;
    /**
     * The restore wizard: uploading the blobs under a `restore_session_id`, with no local item
     * commit. modules/export calls this instead of importing modules/files directly.
     */
    stageRestoreUpload(args: {
        file: File;
        parentId: string | null;
        name: string;
        itemId: string;
        restoreSessionId: string;
        sortOrder?: string;
        createdAt?: number;
        version?: number;
        description?: string;
        onProgress?: (p: {
            phase: string;
            chunkIndex?: number;
            totalChunks?: number;
            chunkPct?: number;
        }) => void;
    }): Promise<EncryptedItem>;
}

let impl: FileBridge | null = null;

/** modules/files calls this once during the (app) layout's bootstrap. */
export function registerFileBridge(bridge: FileBridge): void {
    impl = bridge;
}

let syncPinnedChunksImpl: (() => Promise<void>) | null = null;

/** pin-orchestrator (in modules) registers this function (the call is in pin-orchestrator.ts). */
export function registerSyncPinnedChunks(fn: () => Promise<void>): void {
    syncPinnedChunksImpl = fn;
}

/** The bridge core/* calls — it delegates to the registered implementation, or safely does nothing. */
export const fileBridge: FileBridge = {
    invalidateFile: (fileId) => impl?.invalidateFile(fileId) ?? Promise.resolve(),
    clearBlobCache: () => impl?.clearBlobCache(),
    cancelPendingTrash: () => impl?.cancelPendingTrash(),
    getFilePayload: (fileId) => impl?.getFilePayload(fileId) ?? Promise.resolve(null),
    moveFileEmbedBetweenNotes: (fileId, fromNoteId, toNoteId, fileName, mime) =>
        impl?.moveFileEmbedBetweenNotes(fileId, fromNoteId, toNoteId, fileName, mime) ??
        Promise.resolve(),
    syncPinnedChunks: () => syncPinnedChunksImpl?.() ?? Promise.resolve(),
    isPinnedChunkSet: (chunkSetId) =>
        impl?.isPinnedChunkSet?.(chunkSetId) ?? Promise.resolve(false),
    getPinnedChunkSetIds: () =>
        impl?.getPinnedChunkSetIds?.() ?? Promise.resolve(new Set<string>()),
    cleanupOrphanedFileRefs: (fileIds) =>
        impl?.cleanupOrphanedFileRefs(fileIds) ?? Promise.resolve([]),
    stageRestoreUpload: (args) => {
        if (!impl?.stageRestoreUpload) {
            return Promise.reject(new Error("file bridge is not registered"));
        }
        return impl.stageRestoreUpload(args);
    },
};
