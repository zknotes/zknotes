// The retention sweep must not run over a concurrent restore.
//
// `gc.ts` C.2 picks candidates with a `SELECT` OUTSIDE the transaction, so between the pick and the
// purge the user can restore the item from Trash. Before the fix, `purgeOwnedItem` re-checked only
// `purged_at`, so a restore silently lost the race instead of winning it.
//
// The guard is deliberately OPT-IN (`expiredTrashOnly`): a direct hard delete of a READY row through
// `delete_ids` is a supported contract (`purgeItemTx` sets its `deleted_at` via COALESCE), and the
// state guard for user actions lives on the client (`FileLifecycle.can`). The last two tests lock
// that in.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { items, syncDeletedLog } from "../../src/db/schema";
import { nowSec } from "../../src/lib/time";
import { purgeOwnedItem } from "../../src/services/item-service";
import { insertUser, resetDb } from "../helpers";

const USER = "user-1";
const RETENTION = 30 * 24 * 3600;

async function insertNote(
    id: string,
    opts: { deletedAt?: number | null; purgedAt?: number | null; version?: number } = {},
) {
    await db.insert(items).values({
        id,
        user_id: USER,
        type: "note",
        sort_order: "m",
        version: opts.version ?? 1,
        encrypted_payload: Buffer.from("ciphertext"),
        payload_nonce: Buffer.alloc(24),
        deleted_at: opts.deletedAt ?? null,
        purged_at: opts.purgedAt ?? null,
    });
}

async function readNote(id: string) {
    const [row] = await db.select().from(items).where(eq(items.id, id)).limit(1);
    return row;
}

async function countDeletedLog(id: string) {
    const rows = await db.select().from(syncDeletedLog).where(eq(syncDeletedLog.item_id, id));
    return rows.length;
}

/** Mirrors `gc.ts` C.2: the same cutoff in the candidate selection and in the re-check inside the transaction. */
function gcPurge(id: string, now: number, cutoff: number) {
    return db.transaction(async (tx) =>
        purgeOwnedItem(tx, id, USER, now, undefined, { expiredTrashOnly: { cutoff } }),
    );
}

describe("purgeOwnedItem — retention sweep guard", () => {
    beforeEach(async () => {
        await resetDb();
        await insertUser(USER);
    });

    test("GC skips an item restored from Trash after the candidates were picked (deleted_at cleared)", async () => {
        const now = nowSec();
        // The candidate was picked while it had spent 35 days in Trash; a restore brought it back meanwhile.
        await insertNote("restored", { deletedAt: null, version: 5 });

        expect(await gcPurge("restored", now, now - RETENTION)).toBe(false);

        const row = await readNote("restored");
        expect(row!.purged_at).toBeNull();
        expect(row!.encrypted_payload).not.toBeNull();
        expect(await countDeletedLog("restored")).toBe(0);
    });

    test("GC skips an item restored and then re-trashed (a fresh deleted_at, above the cutoff)", async () => {
        const now = nowSec();
        await insertNote("restored-then-retrashed", { deletedAt: now - 60, version: 4 });

        expect(await gcPurge("restored-then-retrashed", now, now - RETENTION)).toBe(false);

        const row = await readNote("restored-then-retrashed");
        expect(row!.purged_at).toBeNull();
        expect(row!.encrypted_payload).not.toBeNull();
        expect(await countDeletedLog("restored-then-retrashed")).toBe(0);
    });

    test("GC still purges legitimately expired trash (the guard must not stop the sweep)", async () => {
        const now = nowSec();
        await insertNote("expired-trash", { deletedAt: now - 35 * 24 * 3600, version: 2 });

        expect(await gcPurge("expired-trash", now, now - RETENTION)).toBe(true);

        const row = await readNote("expired-trash");
        expect(row!.purged_at).not.toBeNull();
        expect(row!.encrypted_payload).toBeNull();
        expect(await countDeletedLog("expired-trash")).toBe(1);
    });

    test("the guard is opt-in: without it a direct hard delete of a READY row still passes (the delete_ids contract)", async () => {
        await insertNote("live-note");

        const purged = await db.transaction(async (tx) =>
            purgeOwnedItem(tx, "live-note", USER, nowSec()),
        );

        expect(purged).toBe(true);
        const row = await readNote("live-note");
        // purgeItemTx sets deleted_at through COALESCE when the row did not have one
        expect(row!.deleted_at).toBeGreaterThan(0);
        expect(row!.purged_at).not.toBeNull();
    });

    test("it stays idempotent over an already-purged row (in both variants)", async () => {
        const ts = nowSec() - 100;
        await insertNote("already-purged", { deletedAt: ts, purgedAt: ts });

        const plain = await db.transaction(async (tx) =>
            purgeOwnedItem(tx, "already-purged", USER, nowSec()),
        );
        const guarded = await gcPurge("already-purged", nowSec(), nowSec());

        expect(plain).toBe(false);
        expect(guarded).toBe(false);
        expect(await countDeletedLog("already-purged")).toBe(0);
    });
});
