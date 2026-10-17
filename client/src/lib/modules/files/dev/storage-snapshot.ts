import type { QueryClient } from "@tanstack/svelte-query";
import { getStorage } from "$lib/core/api/files";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { hasVaultKey } from "$lib/core/crypto/session-key";
import type { PendingUpload } from "$lib/core/db";
import { getDB } from "$lib/core/db";
import { pingWorker } from "$lib/core/workers/crypto-rpc";
import { getBlobCacheDevStats } from "../blob-cache";
import { isStagingComplete } from "../opfs-staging";

export interface StorageLayerStat {
    id: string;
    label: string;
    rowCount: number;
    bytes: number | null;
    sensitivity: "plaintext" | "ciphertext" | "metadata" | "public";
    detail?: string;
}

export interface StorageSnapshot {
    collectedAt: number;
    quota: { usage: number; quota: number } | null;
    persistOutcome: boolean | "unsupported";
    idb: StorageLayerStat[];
    opfs: {
        stagingId: string;
        bytes: number | null;
        linkedPending: { local_id: string; phase: string } | null;
        complete: boolean | null;
    }[];
    pendingWithoutStaging: string[];
    staleUploadChunks: number;
    pendingUploads: Omit<PendingUpload, "blob">[];
    blobCache: ReturnType<typeof getBlobCacheDevStats>;
    swCaches: { name: string; bytes: number | null }[];
    cryptoWorker: { unlocked: boolean } | null;
    vaultKeyPresent: boolean;
    localStorageStats: { pinnedCount: number | null; syncMode: string | null };
    queryCache: {
        treeItemsCount: number | null;
        deletedItemsCount: number | null;
        noteEntries: number;
        totalQueries: number;
    } | null;
    server?: {
        breakdown: {
            files_bytes: number;
            items_bytes: number;
            history_bytes: number;
            trashed_bytes: number;
            total_used: number;
        };
        storage_quota: number;
        max_file_size: number;
    };
}

export async function collectStorageSnapshot(opts?: {
    includeServer?: boolean;
    computeExactSizes?: boolean;
    queryClient?: QueryClient;
}): Promise<StorageSnapshot> {
    const db = await getDB();
    const idb: StorageLayerStat[] = [];

    idb.push({
        id: "items",
        label: "items",
        rowCount: await db.count("items"),
        bytes: null,
        sensitivity: "ciphertext",
    });
    idb.push({
        id: "file-chunks",
        label: "file-chunks",
        rowCount: await db.count("file-chunks"),
        bytes: null,
        sensitivity: "ciphertext",
    });
    idb.push({
        id: "pending-uploads",
        label: "pending-uploads",
        rowCount: await db.count("pending-uploads"),
        bytes: null,
        sensitivity: "plaintext",
        detail: "⚠ plaintext pipeline",
    });
    idb.push({
        id: "upload-chunks",
        label: "upload-chunks",
        rowCount: await db.count("upload-chunks"),
        bytes: null,
        sensitivity: "ciphertext",
    });
    idb.push({
        id: "mutation-queue",
        label: "mutation-queue",
        rowCount: await db.count("mutation-queue"),
        bytes: null,
        sensitivity: "metadata",
    });
    idb.push({
        id: "search-index",
        label: "search-index",
        rowCount: await db.count("search-index"),
        bytes: null,
        sensitivity: "ciphertext",
    });
    idb.push({
        id: "metadata",
        label: "metadata",
        rowCount: await db.count("metadata"),
        bytes: null,
        sensitivity: "metadata",
    });

    const quota =
        navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    let persistOutcome: boolean | "unsupported" = "unsupported";
    if (navigator.storage && navigator.storage.persisted) {
        persistOutcome = await navigator.storage.persisted();
    }

    const allPending = await db.getAll("pending-uploads");
    const allUploadChunks = await db.getAllKeys("upload-chunks");
    const activeIds = new Set(allPending.map((p: PendingUpload) => p.local_id));
    let staleUploadChunks = 0;
    for (const key of allUploadChunks) {
        const pendingId = (key as string).split(":")[0];
        if (!activeIds.has(pendingId)) staleUploadChunks++;
    }

    const opfs = [];
    const pendingWithoutStaging: string[] = [];

    try {
        const root = await navigator.storage.getDirectory();
        const uploads = await root.getDirectoryHandle("uploads", { create: false });
        for await (const [stagingId, handle] of (uploads as any).entries()) {
            if (handle.kind !== "directory") continue;
            let bytes: number | null = null;
            try {
                const dir = handle as FileSystemDirectoryHandle;
                const source = await dir.getFileHandle("source", { create: false });
                const file = await source.getFile();
                bytes = file.size;
            } catch (e) {
                // locked by worker
            }
            const pending = allPending.find((p: PendingUpload) => p.staging_id === stagingId);
            opfs.push({
                stagingId,
                bytes,
                linkedPending: pending
                    ? { local_id: pending.local_id, phase: pending.phase || "" }
                    : null,
                complete: pending ? isStagingComplete(pending as any) : null,
            });
        }

        for (const p of allPending) {
            if (p.staging_id && !opfs.find((o) => o.stagingId === p.staging_id)) {
                pendingWithoutStaging.push(p.local_id);
            }
        }
    } catch (e) {
        // no uploads dir or unsupported
    }

    const swCaches = [];
    if ("caches" in window) {
        const keys = await caches.keys();
        for (const key of keys) swCaches.push({ name: key, bytes: null });
    }

    let server:
        | {
              breakdown: {
                  files_bytes: number;
                  items_bytes: number;
                  history_bytes: number;
                  trashed_bytes: number;
                  total_used: number;
              };
              storage_quota: number;
              max_file_size: number;
          }
        | undefined;
    if (opts?.includeServer) {
        try {
            const res = await getStorage();
            if (res)
                server = {
                    breakdown: {
                        files_bytes: res.breakdown.files_bytes,
                        items_bytes: res.breakdown.items_bytes,
                        history_bytes: res.breakdown.history_bytes,
                        trashed_bytes: res.breakdown.trashed_bytes,
                        total_used: res.breakdown.total_used,
                    },
                    storage_quota: res.storage_quota,
                    max_file_size: res.max_file_size,
                };
        } catch {}
    }

    let queryCacheInfo = null;
    if (opts?.queryClient) {
        const queryCache = opts.queryClient.getQueryCache();
        const itemsList = opts.queryClient.getQueryData<any>(QUERY_KEYS.treeItems);
        const deletedList = opts.queryClient.getQueryData<any>(QUERY_KEYS.deletedItems);
        queryCacheInfo = {
            treeItemsCount: itemsList ? itemsList.length : null,
            deletedItemsCount: deletedList ? deletedList.length : null,
            noteEntries: queryCache.findAll({ queryKey: ["note"] }).length,
            totalQueries: queryCache.getAll().length,
        };
    }

    const syncMode = localStorage.getItem("sync-settings") || null;

    let workerUnlocked = false;
    try {
        workerUnlocked = await pingWorker();
    } catch (e) {}

    return {
        collectedAt: Date.now(),
        quota: quota as any,
        persistOutcome,
        idb,
        opfs,
        pendingWithoutStaging,
        staleUploadChunks,
        pendingUploads: allPending.map(({ blob, ...rest }: any) => rest),
        blobCache: getBlobCacheDevStats(),
        swCaches,
        cryptoWorker: { unlocked: workerUnlocked },
        vaultKeyPresent: hasVaultKey(),
        localStorageStats: { pinnedCount: null, syncMode },
        queryCache: queryCacheInfo,
        server,
    };
}
