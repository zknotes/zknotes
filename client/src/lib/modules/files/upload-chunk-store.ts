// The temporary IDB staging ciphertext for a resumable upload.
import { getDB, type StagedUploadChunk } from "$lib/core/db";

export function uploadChunkKey(pendingLocalId: string, index: number): string {
    return `${pendingLocalId}:${index}`;
}

export async function persistUploadChunk(
    pendingLocalId: string,
    index: number,
    ciphertext: Uint8Array,
    nonce: string,
    hash: string,
): Promise<void> {
    const db = await getDB();
    const row: StagedUploadChunk = {
        key: uploadChunkKey(pendingLocalId, index),
        pendingLocalId,
        index,
        ciphertext,
        nonce,
        hash,
        size: ciphertext.byteLength,
        storedAt: Date.now(),
    };
    await db.put("upload-chunks", row);
}

export async function loadUploadChunk(
    pendingLocalId: string,
    index: number,
): Promise<StagedUploadChunk | null> {
    const db = await getDB();
    return (await db.get("upload-chunks", uploadChunkKey(pendingLocalId, index))) ?? null;
}

export async function deleteUploadChunk(pendingLocalId: string, index: number): Promise<void> {
    const db = await getDB();
    await db.delete("upload-chunks", uploadChunkKey(pendingLocalId, index));
}

export async function deleteAllUploadChunks(pendingLocalId: string): Promise<void> {
    const db = await getDB();
    const keys = await db.getAllKeysFromIndex("upload-chunks", "by-pending", pendingLocalId);
    await Promise.all(keys.map((key) => db.delete("upload-chunks", key)));
}
