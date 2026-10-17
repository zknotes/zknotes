// The blob sweep (section C) picks the sets past their grace in one scan and deletes them one by
// one. A conflict copy can take a set back in between (reclaimChunkSetFromPendingDelete clears
// pending_delete_at); deleting the row by id alone then deleted a file that was live again.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { db, pgClient } from "../src/db";
import { chunkSets } from "../src/db/schema";
import { runGc } from "../src/gc";
import { nowSec } from "../src/lib/time";
import { insertChunkSet, resetDb } from "./helpers";

beforeEach(resetDb);

describe("runGc — section C against a concurrent reclaim", () => {
    test("a set taken back while the sweep is running is not deleted", async () => {
        const csId = uuidv7();
        const now = nowSec();
        await insertChunkSet(csId, uuidv7(), { pendingDeleteAt: now - 10_000 });

        // The reclaim holds the row lock, uncommitted, while the sweep scans (it still sees the
        // committed pending row) and then blocks on the delete until the reclaim commits.
        let reclaimStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            reclaimStarted = resolve;
        });
        const reclaim = pgClient.begin(async (tx) => {
            await tx`UPDATE chunk_sets SET pending_delete_at = NULL WHERE id = ${csId}`;
            reclaimStarted();
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });
        await started;

        const sweep = runGc({ now, blobPurgeGrace: 0 });
        await reclaim;
        const result = await sweep;

        const [row] = await db.select().from(chunkSets).where(eq(chunkSets.id, csId));
        expect(row?.pending_delete_at).toBeNull();
        expect(result.blobsPurged).toBe(0);
    });

    test("a set still pending is deleted as before", async () => {
        const csId = uuidv7();
        const now = nowSec();
        await insertChunkSet(csId, uuidv7(), { pendingDeleteAt: now - 10_000 });

        const result = await runGc({ now, blobPurgeGrace: 0 });

        expect(await db.select().from(chunkSets).where(eq(chunkSets.id, csId))).toEqual([]);
        expect(result.blobsPurged).toBe(1);
    });
});
