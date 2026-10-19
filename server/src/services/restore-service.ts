// The restore session's staging and its release — data logic the route module and the GC sweeper
// both need. It used to live in `routes/restore.ts`, so the background sweeper imported an HTTP
// route module (and, through it, the Fastify plugin) for one function.
import { and, eq, isNull } from "drizzle-orm";
import { markPendingDelete } from "../blob-sweeper";
import {
    chunkSets,
    fileChunks,
    items,
    restoreSessions,
    restoreStagedItems,
    uploadSessions,
} from "../db/schema";
import type { DbExecutor } from "../db/types";
import { getItemStorageSize as itemStorageSize, updateQuotaTx } from "./quota-service";

export type RestoreSessionRow = typeof restoreSessions.$inferSelect;

/**
 * Idempotently release the staging (quota plus rows). The S3 prefixes are deleted AFTER the transaction.
 */
export async function releaseRestoreStaging(
    executor: DbExecutor,
    session: RestoreSessionRow,
): Promise<{ prefixes: Array<{ userId: string; id: string }> }> {
    const prefixes: Array<{ userId: string; id: string }> = [];
    const staged = await executor
        .select()
        .from(restoreStagedItems)
        .where(eq(restoreStagedItems.restore_session_id, session.id));
    let itemBytes = 0;
    for (const row of staged) itemBytes += itemStorageSize(row);
    if (staged.length > 0) {
        await executor
            .delete(restoreStagedItems)
            .where(eq(restoreStagedItems.restore_session_id, session.id));
    }

    const uploads = await executor
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.restore_session_id, session.id));
    let fileBytes = 0;
    for (const u of uploads) {
        if (u.status === "restore_staging") fileBytes += Number(u.total_size);
        await executor.delete(fileChunks).where(eq(fileChunks.chunk_set_id, u.id));
        await executor.delete(uploadSessions).where(eq(uploadSessions.id, u.id));
        prefixes.push({ userId: u.user_id, id: u.id });
    }

    const sets = await executor
        .select()
        .from(chunkSets)
        .where(eq(chunkSets.restore_session_id, session.id));
    for (const cs of sets) {
        // A live item that references the set keeps it: deleting the blob under a reference loses
        // the file. Item routes cannot bind a staged set (chunkSetCommitted), so this only guards
        // a reference that got in some other way; the set stops being staging and stays charged.
        const [referenced] = await executor
            .select({ id: items.id })
            .from(items)
            .where(
                and(
                    eq(items.chunk_set_id, cs.id),
                    eq(items.user_id, cs.user_id),
                    isNull(items.purged_at),
                ),
            )
            .limit(1);
        if (referenced) {
            await executor
                .update(chunkSets)
                .set({ restore_session_id: null })
                .where(eq(chunkSets.id, cs.id));
            continue;
        }
        const marked = await markPendingDelete(cs.id, cs.user_id, executor);
        if (marked) fileBytes += Number(cs.total_size);
        prefixes.push({ userId: cs.user_id, id: cs.id });
    }

    if (itemBytes !== 0 || fileBytes !== 0) {
        await updateQuotaTx(
            executor,
            session.user_id,
            { items: -itemBytes, files: -fileBytes },
            false,
        );
    }
    return { prefixes };
}
