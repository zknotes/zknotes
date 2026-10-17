import { apiFetch } from "$lib/core/api";
import { getDB } from "$lib/core/db";
import { pinManager } from "$lib/core/files/pin-manager-state.svelte";
import { getBlobCacheEntryStats } from "$lib/modules/files/blob-cache";
import { pendingTrashManager } from "$lib/modules/files/pending-trash";
import { getSyncSettings } from "$lib/modules/files/sync-settings";

export interface FileTraceResult {
    id: string; // the input
    resolvedType: "fileId" | "localId" | "not_found";

    // If it's a fileId
    item?: {
        parent_id: string | null;
        chunk_set_id: string;
        purged_at: number | null;
        deleted_at: number | null;
        version: number;
    };
    trash?: {
        deleted_at: number | null;
        is_pending_trash: boolean;
    };
    sync?: {
        is_pinned: boolean;
        sync_mode: string | null;
    };
    fileChunks?: {
        cachedChunks: number;
        totalBytes: number;
    };
    blobCache?: {
        refs: number;
        render: string;
    };

    // If it's a localId or we resolved to localId
    pending?: {
        phase: string;
        opfs_bytes: number | null;
    };

    server?: {
        status: "ok" | "not_found" | "error";
        chunk_set_id?: string;
        total_size?: number;
    };
}

export async function traceFile(id: string): Promise<FileTraceResult> {
    const isLocal = id.startsWith("local:");
    const db = await getDB();

    const resolvedType: "fileId" | "localId" | "not_found" = isLocal ? "localId" : "fileId";

    const res: FileTraceResult = {
        id,
        resolvedType,
    };

    let targetChunkSetId: string | undefined;

    if (!isLocal) {
        const item = await db.get("items", id);
        if (!item) {
            res.resolvedType = "not_found";
            return res;
        }

        res.item = {
            parent_id: item.parent_id,
            chunk_set_id: item.chunk_set_id ?? "",
            purged_at: item.purged_at ?? null,
            deleted_at: item.deleted_at ?? null,
            version: item.version ?? 0,
        };
        targetChunkSetId = item.chunk_set_id ?? undefined;

        res.trash = {
            deleted_at: item.deleted_at ?? null,
            is_pending_trash: pendingTrashManager.isPending(id),
        };

        res.sync = {
            is_pinned: pinManager.isPinned(id),
            sync_mode: getSyncSettings().autoDownload,
        };

        if (targetChunkSetId) {
            const tx = db.transaction("file-chunks", "readonly");
            const index = tx.store.index("by-chunk-set");
            let cachedChunks = 0;
            let totalBytes = 0;
            let cursor = await index.openCursor(IDBKeyRange.only(targetChunkSetId));
            while (cursor) {
                cachedChunks++;
                totalBytes += cursor.value.ciphertext.byteLength;
                cursor = await cursor.continue();
            }
            res.fileChunks = { cachedChunks, totalBytes };

            const bcStats = getBlobCacheEntryStats(id);
            if (bcStats) {
                res.blobCache = bcStats;
            }
        }
    } else {
        const pending = await db.get("pending-uploads", id);
        if (!pending) {
            res.resolvedType = "not_found";
            return res;
        }
        res.pending = {
            phase: pending.phase ?? "unknown",
            opfs_bytes: pending.staging_bytes_written ?? null,
        };
        if (pending.chunk_set_id) {
            targetChunkSetId = pending.chunk_set_id;
        }
    }

    if (targetChunkSetId) {
        try {
            const out = await apiFetch(`/uploads/${targetChunkSetId}/status`);
            if (out && typeof out === "object" && "session_status" in out) {
                res.server = {
                    status: "ok",
                    chunk_set_id: targetChunkSetId,
                    total_size: (out as any).total_present_size,
                };
            } else {
                res.server = { status: "error" };
            }
        } catch (e: any) {
            if (e.status === 404) res.server = { status: "not_found" };
            else res.server = { status: "error" };
        }
    }

    return res;
}
