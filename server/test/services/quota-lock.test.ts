import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../../src/db";
import { loginFailures } from "../../src/db/schema";
import { updateQuotaTx } from "../../src/services/quota-service";
import { insertUser, resetDb } from "../helpers";

/**
 * Regression for a production deadlock: the quota update used to take the user's row `FOR UPDATE`,
 * which conflicts with the `FOR KEY SHARE` every insert of a row referencing the user takes for its
 * foreign-key check. A history snapshot insert then waited on an item write's quota lock while that
 * write waited on the item row the insert had already key-shared. With `FOR NO KEY UPDATE` an
 * insert that references the user goes through while the quota row is held.
 */
describe("quota row lock vs foreign-key inserts", () => {
    beforeEach(async () => {
        await resetDb();
        await insertUser("user-1");
    });

    afterAll(async () => {
        await resetDb();
    });

    test("an insert referencing the user does not wait for a transaction holding the quota row", async () => {
        let releaseHolder!: () => void;
        const held = new Promise<void>((r) => {
            releaseHolder = r;
        });
        let holderLocked!: () => void;
        const lockedSignal = new Promise<void>((r) => {
            holderLocked = r;
        });

        // Transaction 1: take the quota row and keep the transaction open.
        const holder = db.transaction(async (tx) => {
            await updateQuotaTx(tx, "user-1", { items: 1 }, false);
            holderLocked();
            await held;
        });
        await lockedSignal;

        // Transaction 2: an insert whose FK check key-shares the user row. It has to finish while
        // transaction 1 still holds the quota row — a 2 s statement timeout turns a wait into a failure.
        const insert = db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
            await tx.insert(loginFailures).values({
                user_id: "user-1",
                source: "198.51.100.1",
                failed_attempts: 1,
                window_started_at: 1,
            });
        });
        await expect(insert).resolves.toBeUndefined();

        releaseHolder();
        await holder;
    }, 10_000);
});
