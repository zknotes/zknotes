// Seal rows: the daily allowance, their quota, and their lifetime with the chunk set they seal.
import { and, eq, gt, sql } from "drizzle-orm";
import type { DbExecutor } from "../db/types";
import { seals, users } from "../db/schema";
import { defaultSealsPerDay, type Entitlements } from "../entitlements";
import { updateQuotaTx } from "./quota-service";

export const SEAL_WINDOW_SEC = 24 * 60 * 60;

/** The user's allowance: the provider's value when it has one, the core's `SEALS_PER_DAY` otherwise. */
export function sealsPerDay(ent: Entitlements): number {
    const v = ent.sealsPerDay;
    return v !== undefined && Number.isSafeInteger(v) && v >= 0 ? v : defaultSealsPerDay();
}

/** Seals created in the last 24 hours — a rolling window, so there is no midnight burst. */
export async function countSealsInWindow(
    tx: DbExecutor,
    userId: string,
    now: number,
): Promise<number> {
    const [row] = await tx
        .select({ n: sql<number>`COUNT(*)::integer` })
        .from(seals)
        .where(and(eq(seals.user_id, userId), gt(seals.created_at, now - SEAL_WINDOW_SEC)));
    return row?.n ?? 0;
}

/**
 * Serialises seal creation per user, so two concurrent requests cannot both pass the count. The same
 * row lock strength as the quota path (`FOR NO KEY UPDATE`), and for the same reason: the seal
 * insert's foreign-key check takes `FOR KEY SHARE` on this row and must not conflict with it.
 */
export async function lockUserForSeal(tx: DbExecutor, userId: string): Promise<boolean> {
    const rows = await tx.execute(
        sql`SELECT ${users.id} FROM ${users} WHERE ${users.id} = ${userId} FOR NO KEY UPDATE`,
    );
    return [...rows].length > 0;
}

type SealBytesRow = {
    encrypted_record: Buffer | null;
    record_nonce: Buffer | null;
    encrypted_seal_key: Buffer | null;
    seal_key_nonce: Buffer | null;
};

/**
 * The bytes a seal row holds — what it costs in the `items` quota bucket. `recomputeUserQuota`
 * carries the same sum in SQL.
 */
export function sealStorageSize(row: SealBytesRow): number {
    return (
        (row.encrypted_record?.byteLength ?? 0) +
        (row.record_nonce?.byteLength ?? 0) +
        (row.encrypted_seal_key?.byteLength ?? 0) +
        (row.seal_key_nonce?.byteLength ?? 0)
    );
}

/**
 * Deletes every seal of a chunk set and gives their bytes back to the owners' quota. GC calls it in
 * the transaction that deletes the chunk set, before the delete: a seal never outlives the bytes it
 * vouches for. The foreign key would cascade anyway; doing it here keeps the quota right.
 */
export async function deleteSealsOfChunkSet(tx: DbExecutor, chunkSetId: string): Promise<number> {
    const gone = await tx.delete(seals).where(eq(seals.chunk_set_id, chunkSetId)).returning({
        user_id: seals.user_id,
        encrypted_record: seals.encrypted_record,
        record_nonce: seals.record_nonce,
        encrypted_seal_key: seals.encrypted_seal_key,
        seal_key_nonce: seals.seal_key_nonce,
    });
    const byUser = new Map<string, number>();
    for (const row of gone) {
        byUser.set(row.user_id, (byUser.get(row.user_id) ?? 0) + sealStorageSize(row));
    }
    for (const [userId, bytes] of byUser) {
        if (bytes > 0) await updateQuotaTx(tx, userId, { items: -bytes }, false);
    }
    return gone.length;
}
