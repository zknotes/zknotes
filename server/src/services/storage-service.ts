// S3/storage helpers — the only implementation of deleting an S3 prefix and of the chunk-set
// ownership check (previously duplicated between gc.ts and routes/files.ts).
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chunkSets, uploadSessions } from "../db/schema";
import { S3_BUCKET, s3 } from "../s3";

/**
 * Deletes every S3 object under `u/<userId>/<chunkSetId>/`. Best effort: errors are swallowed
 * because the deep-repair sweep (gc.ts) picks up whatever is left behind.
 */
export interface ListedUploadChunk {
    index: number;
    size: number;
}

/** A paginated ListObjectsV2 under `u/<userId>/<chunkSetId>/` — one record per index. */
export async function listUploadChunkObjects(
    userId: string,
    chunkSetId: string,
): Promise<ListedUploadChunk[]> {
    const prefix = `u/${userId}/${chunkSetId}/`;
    const byIndex = new Map<number, number>();
    let continuationToken: string | undefined;
    do {
        const listRes = await s3.send(
            new ListObjectsV2Command({
                Bucket: S3_BUCKET,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }),
        );
        for (const obj of listRes.Contents ?? []) {
            const idx = Number((obj.Key ?? "").split("/").pop());
            if (Number.isInteger(idx) && idx >= 0) {
                byIndex.set(idx, obj.Size ?? 0);
            }
        }
        continuationToken = listRes.NextContinuationToken;
    } while (continuationToken);

    return [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, size]) => ({ index, size }));
}

export async function deleteS3Prefix(userId: string, chunkSetId: string): Promise<void> {
    try {
        const prefix = `u/${userId}/${chunkSetId}/`;
        let continuationToken: string | undefined;
        do {
            const listRes = await s3.send(
                new ListObjectsV2Command({
                    Bucket: S3_BUCKET,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                }),
            );
            const objectsToDelete = (listRes.Contents ?? [])
                .filter((obj) => obj.Key)
                .map((obj) => ({ Key: obj.Key! }));
            if (objectsToDelete.length > 0) {
                for (let i = 0; i < objectsToDelete.length; i += 1000) {
                    await s3.send(
                        new DeleteObjectsCommand({
                            Bucket: S3_BUCKET,
                            Delete: { Objects: objectsToDelete.slice(i, i + 1000) },
                        }),
                    );
                }
            }
            continuationToken = listRes.NextContinuationToken;
        } while (continuationToken);
    } catch {
        // best-effort; deep-repair catches the rest
    }
}

/**
 * Chunk-set ownership: a committed set OR a still-live upload session belonging to the same user.
 * (Previously copy-pasted between HEAD and GET /uploads/:id/chunks/:index.)
 */
export async function userOwnsChunkSetOrUpload(
    chunkSetId: string,
    userId: string,
): Promise<boolean> {
    const [ownedSet] = await db
        .select({ id: chunkSets.id })
        .from(chunkSets)
        .where(and(eq(chunkSets.id, chunkSetId), eq(chunkSets.user_id, userId)))
        .limit(1);
    if (ownedSet) return true;

    const [ownedUpload] = await db
        .select({ id: uploadSessions.id })
        .from(uploadSessions)
        .where(and(eq(uploadSessions.id, chunkSetId), eq(uploadSessions.user_id, userId)))
        .limit(1);
    return !!ownedUpload;
}
