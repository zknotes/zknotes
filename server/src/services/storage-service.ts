// S3/storage helpers — the only implementation of deleting an S3 prefix and of the chunk-set
// ownership check (previously duplicated between gc.ts and routes/files.ts).
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chunkSets, uploadSessions } from "../db/schema";
import { S3_BUCKET, s3 } from "../s3";

/**
 * The S3 key layout — the one definition. `storagePrefix` is the owner's `users.storage_prefix`
 * (random, never the user id: the presigned URLs an anonymous share recipient gets carry the key),
 * copied onto the upload session and chunk set so the objects can still be found once the user row
 * is gone.
 */
export function chunkSetPrefix(storagePrefix: string, chunkSetId: string): string {
    return `u/${storagePrefix}/${chunkSetId}/`;
}

export function chunkObjectKey(storagePrefix: string, chunkSetId: string, index: number): string {
    return `${chunkSetPrefix(storagePrefix, chunkSetId)}${index}`;
}

export interface ListedUploadChunk {
    index: number;
    size: number;
}

/** One S3 object as the listing reports it. */
export interface ListedObject {
    key: string;
    size: number;
    lastModified: Date | undefined;
}

/**
 * Every object under `prefix`, page by page (ListObjectsV2 with its continuation token). The one
 * pagination loop — three callers used to write it out: the chunk listing, the prefix delete and
 * the deep repair's bucket walk.
 */
export async function* listObjects(prefix: string): AsyncGenerator<ListedObject> {
    let continuationToken: string | undefined;
    do {
        const page = await s3.send(
            new ListObjectsV2Command({
                Bucket: S3_BUCKET,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }),
        );
        for (const obj of page.Contents ?? []) {
            if (!obj.Key) continue;
            yield { key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified };
        }
        continuationToken = page.NextContinuationToken;
    } while (continuationToken);
}

/** Whether anything at all lives under `prefix` — one request, one key. */
export async function prefixHasObjects(prefix: string): Promise<boolean> {
    const page = await s3.send(
        new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, MaxKeys: 1 }),
    );
    return (page.Contents?.length ?? 0) > 0;
}

/** Deletes the given keys in batches of 1000 (the DeleteObjects cap). */
export async function deleteObjectKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
        await s3.send(
            new DeleteObjectsCommand({
                Bucket: S3_BUCKET,
                Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
            }),
        );
    }
}

/** The objects under the chunk set's prefix — one record per index, sorted. */
export async function listUploadChunkObjects(
    storagePrefix: string,
    chunkSetId: string,
): Promise<ListedUploadChunk[]> {
    const byIndex = new Map<number, number>();
    for await (const obj of listObjects(chunkSetPrefix(storagePrefix, chunkSetId))) {
        const idx = Number(obj.key.split("/").pop());
        if (Number.isInteger(idx) && idx >= 0) byIndex.set(idx, obj.size);
    }
    return [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, size]) => ({ index, size }));
}

/**
 * Deletes every S3 object under the chunk set's prefix. Best effort: errors are swallowed
 * because the deep-repair sweep (gc.ts) picks up whatever is left behind.
 */
export async function deleteS3Prefix(storagePrefix: string, chunkSetId: string): Promise<void> {
    try {
        const keys: string[] = [];
        for await (const obj of listObjects(chunkSetPrefix(storagePrefix, chunkSetId))) {
            keys.push(obj.key);
        }
        await deleteObjectKeys(keys);
    } catch {
        // best-effort; deep-repair catches the rest
    }
}

/**
 * Chunk-set ownership, answered with the key prefix the objects live under: a committed set OR a
 * still-live upload session belonging to the same user, else null. (Previously copy-pasted between
 * HEAD and GET /uploads/:id/chunks/:index.)
 */
export async function storagePrefixForChunkSet(
    chunkSetId: string,
    userId: string,
): Promise<string | null> {
    const [ownedSet] = await db
        .select({ storage_prefix: chunkSets.storage_prefix })
        .from(chunkSets)
        .where(and(eq(chunkSets.id, chunkSetId), eq(chunkSets.user_id, userId)))
        .limit(1);
    if (ownedSet) return ownedSet.storage_prefix;

    const [ownedUpload] = await db
        .select({ storage_prefix: uploadSessions.storage_prefix })
        .from(uploadSessions)
        .where(and(eq(uploadSessions.id, chunkSetId), eq(uploadSessions.user_id, userId)))
        .limit(1);
    return ownedUpload?.storage_prefix ?? null;
}
