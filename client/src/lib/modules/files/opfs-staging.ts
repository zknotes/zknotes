// The OPFS plaintext staging before openUpload. It falls back to an async Writable or an IDB blob.
import {
    deleteStagingDir,
    opfsSupportsSync,
    readSourceSlice as readSourceSliceSync,
    truncateSource,
    writeSourceBlock,
} from "$lib/core/workers/opfs-io-rpc";

export const STAGING_BLOCK_SIZE = 1024 * 1024; // 1 MiB
export const LEGACY_BLOB_MAX_BYTES = 500 * 1024 * 1024; // 500 MB — IDB fallback without OPFS

export type OpfsCapability = "sync" | "async" | "none";

export async function getOpfsCapability(): Promise<OpfsCapability> {
    if (typeof navigator?.storage?.getDirectory !== "function") return "none";
    if (await opfsSupportsSync()) return "sync";
    return "async";
}

export function shouldWarnNoResume(capability: OpfsCapability, fileSize: number): boolean {
    return capability === "none" && fileSize > LEGACY_BLOB_MAX_BYTES;
}

async function ensureQuota(fileSize: number): Promise<void> {
    if (typeof navigator.storage?.estimate !== "function") return;
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const available = quota - usage;
    if (available < fileSize * 1.1) {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    }
}

async function getStagingDir(stagingId: string): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    const uploads = await root.getDirectoryHandle("uploads", { create: true });
    return uploads.getDirectoryHandle(stagingId, { create: true });
}

async function stageWithAsyncWritable(
    file: Blob,
    stagingId: string,
    opts: StageFileOptions,
): Promise<void> {
    const dir = await getStagingDir(stagingId);
    const fh = await dir.getFileHandle("source", { create: true });
    const writable = await fh.createWritable();
    let written = 0;
    try {
        while (written < file.size) {
            if (opts.signal?.aborted) throw new DOMException("Staging aborted", "AbortError");
            const end = Math.min(written + STAGING_BLOCK_SIZE, file.size);
            const block = file.slice(written, end);
            await writable.write(block);
            written = end;
            opts.onProgress?.(written, file.size);
            await opts.onBlockWritten?.(written);
        }
    } finally {
        await writable.close();
    }
}

/**
 * Copies a file into OPFS `uploads/{stagingId}/source` in 1 MiB blocks.
 * It updates `staging_bytes_written` through a callback after each block.
 */
export async function stageFileToOpfs(file: Blob, stagingId: string, opts: StageFileOptions = {}) {
    await ensureQuota(file.size);
    const capability = await getOpfsCapability();
    if (capability === "none") {
        throw new Error("OPFS not available");
    }

    if (capability === "sync") {
        await truncateSource(stagingId, file.size);
        let written = 0;
        while (written < file.size) {
            if (opts.signal?.aborted) throw new DOMException("Staging aborted", "AbortError");
            const end = Math.min(written + STAGING_BLOCK_SIZE, file.size);
            const block = new Uint8Array(await file.slice(written, end).arrayBuffer());
            await writeSourceBlock(stagingId, written, block);
            written = end;
            opts.onProgress?.(written, file.size);
            await opts.onBlockWritten?.(written);
        }
        return;
    }

    await stageWithAsyncWritable(file, stagingId, opts);
}

export interface StageFileOptions {
    onProgress?: (written: number, total: number) => void;
    onBlockWritten?: (written: number) => Promise<void>;
    signal?: AbortSignal;
}

export async function readStagingSlice(
    stagingId: string,
    offset: number,
    length: number,
): Promise<Uint8Array> {
    const capability = await getOpfsCapability();
    if (capability === "sync") {
        return readSourceSliceSync(stagingId, offset, length);
    }
    const dir = await getStagingDir(stagingId);
    const fh = await dir.getFileHandle("source", { create: false });
    const file = await fh.getFile();
    const slice = file.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
}

/** A blob URL for a preview out of the OPFS source. The caller has to revoke it. */
export async function createSourcePreviewUrl(
    stagingId: string,
    mime: string,
    size: number,
): Promise<string> {
    if (size <= STAGING_BLOCK_SIZE * 4) {
        const bytes = await readStagingSlice(stagingId, 0, size);
        return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    }
    const dir = await getStagingDir(stagingId);
    const fh = await dir.getFileHandle("source", { create: false });
    const file = await fh.getFile();
    return URL.createObjectURL(new Blob([file], { type: mime }));
}

export function isStagingComplete(pending: {
    staging_id?: string;
    staging_bytes_written?: number;
    plain_size?: number;
}): boolean {
    return (
        pending.staging_id !== undefined &&
        pending.plain_size !== undefined &&
        pending.staging_bytes_written === pending.plain_size
    );
}

export async function deleteStaging(stagingId: string): Promise<void> {
    const capability = await getOpfsCapability();
    if (capability === "sync") {
        await deleteStagingDir(stagingId);
        return;
    }
    try {
        const root = await navigator.storage.getDirectory();
        const uploads = await root.getDirectoryHandle("uploads", { create: false });
        await uploads.removeEntry(stagingId, { recursive: true });
    } catch {
        // already deleted
    }
}
