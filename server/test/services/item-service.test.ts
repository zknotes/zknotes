import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { db } from "../../src/db";
import { chunkSets, items, users } from "../../src/db/schema";
import { nowSec } from "../../src/lib/time";
import { purgeItemTx } from "../../src/services/item-service";

describe("item-service cascade logic", () => {
    let testUserId: string;

    beforeAll(async () => {
        testUserId = uuidv7();
        await db.insert(users).values({
            id: testUserId,
            email: `test-${testUserId}@example.com`,
            auth_key_hash: "hash",
            kdf_salt: Buffer.from("salt"),
            kdf_params: "{}",
            encrypted_vault_key: Buffer.from("key"),
            vault_key_nonce: Buffer.from("nonce"),
            storage_used_files: 5000,
            storage_quota: 10000,
        });
    });

    afterAll(async () => {
        await db.delete(users).where(eq(users.id, testUserId));
    });

    test("purgeItemTx keeps chunk_set_id if another item references it (conflict copy)", async () => {
        const chunkSetId = uuidv7();

        // 1. Create a chunk_set
        await db.insert(chunkSets).values({
            id: chunkSetId,
            user_id: testUserId,
            chunk_count: 1,
            total_size: 1000,
            pending_delete_at: null,
        });

        // 2. Create two items referencing it (simulating original and conflict copy)
        const item1Id = uuidv7();
        const item2Id = uuidv7();

        await db.insert(items).values([
            {
                id: item1Id,
                user_id: testUserId,
                type: "file",
                version: 1,
                chunk_set_id: chunkSetId,
                sort_order: "a",
                created_at: nowSec(),
                updated_at: nowSec(),
            },
            {
                id: item2Id,
                user_id: testUserId,
                type: "file",
                version: 1,
                chunk_set_id: chunkSetId,
                sort_order: "b",
                created_at: nowSec(),
                updated_at: nowSec(),
            },
        ]);

        // 3. Purge item 1
        await db.transaction(async (tx) => {
            const [current] = await tx.select().from(items).where(eq(items.id, item1Id));
            if (!current) throw new Error("Not found");
            await purgeItemTx(tx, current, testUserId, nowSec());
        });

        // 4. Verify chunk_set is NOT marked for deletion and storage_used_files is NOT reduced
        const [cs] = await db.select().from(chunkSets).where(eq(chunkSets.id, chunkSetId));
        expect(cs).toBeDefined();
        expect(cs!.pending_delete_at).toBeNull();

        const [u] = await db.select().from(users).where(eq(users.id, testUserId));
        expect(u).toBeDefined();
        expect(u!.storage_used_files).toBe(5000);

        // 5. Purge item 2
        await db.transaction(async (tx) => {
            const [current] = await tx.select().from(items).where(eq(items.id, item2Id));
            if (!current) throw new Error("Not found");
            await purgeItemTx(tx, current, testUserId, nowSec());
        });

        // 6. Verify chunk_set IS marked for deletion and storage_used_files IS reduced
        const [csAfter] = await db.select().from(chunkSets).where(eq(chunkSets.id, chunkSetId));
        expect(csAfter).toBeDefined();
        expect(csAfter!.pending_delete_at).not.toBeNull();

        const [uAfter] = await db.select().from(users).where(eq(users.id, testUserId));
        expect(uAfter).toBeDefined();
        expect(uAfter!.storage_used_files).toBe(4000); // 5000 - 1000
    });
});
