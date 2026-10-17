import { sql } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";

// console.log is kept for this backfill script

async function main() {
    console.log("Starting quota backfill...");

    const allUsers = await db.select({ id: users.id }).from(users);
    console.log(`Found ${allUsers.length} users to backfill.`);

    for (const u of allUsers) {
        console.log(`Processing user ${u.id}...`);

        await db.transaction(async (tx) => {
            // storage_used_files (only files that are neither trashed nor deleted)
            // In fact chunkSets carries total_size for every active blob.
            // Every chunk_set_id bound to a NON-trashed item:
            const [filesResult] = await tx.execute(sql`
                SELECT COALESCE(SUM(cs.total_size), 0)::bigint as sum
                FROM chunk_sets cs
                WHERE cs.user_id = ${u.id}
                  AND cs.pending_delete_at IS NULL
                  AND EXISTS (
                      SELECT 1 FROM items i
                      WHERE i.chunk_set_id = cs.id
                        AND i.user_id = cs.user_id
                        AND i.deleted_at IS NULL
                        AND i.purged_at IS NULL
                  )
            `);
            const [uploadsResult] = await tx.execute(sql`
                SELECT COALESCE(SUM(total_size), 0)::bigint as sum
                FROM upload_sessions
                WHERE user_id = ${u.id} AND status IN ('uploading', 'restore_staging')
            `);

            const [restoreSetsResult] = await tx.execute(sql`
                SELECT COALESCE(SUM(cs.total_size), 0)::bigint as sum
                FROM chunk_sets cs
                WHERE cs.user_id = ${u.id}
                  AND cs.pending_delete_at IS NULL
                  AND EXISTS (
                      SELECT 1 FROM restore_sessions rs
                      WHERE rs.id = cs.restore_session_id
                        AND rs.status = 'open'
                  )
            `);

            const filesSum =
                Number(filesResult?.sum ?? 0) +
                Number(uploadsResult?.sum ?? 0) +
                Number(restoreSetsResult?.sum ?? 0);

            // storage_used_items (every item that is not deleted, summing the lengths of the crypto fields)
            const [itemsResult] = await tx.execute(sql`
                SELECT COALESCE(SUM(
                    COALESCE(octet_length(encrypted_payload), 0) +
                    COALESCE(octet_length(encrypted_item_key), 0) +
                    COALESCE(octet_length(payload_nonce), 0) +
                    COALESCE(octet_length(item_key_nonce), 0)
                ), 0)::bigint as sum
                FROM items
                WHERE user_id = ${u.id}
                  AND deleted_at IS NULL
                  AND purged_at IS NULL
                  AND encrypted_payload IS NOT NULL
            `);
            const itemsSum = Number(itemsResult?.sum ?? 0);

            // storage_used_history (every history snapshot)
            const [historyResult] = await tx.execute(sql`
                SELECT COALESCE(SUM(
                    COALESCE(octet_length(encrypted_payload), 0) +
                    COALESCE(octet_length(encrypted_item_key), 0) +
                    COALESCE(octet_length(payload_nonce), 0) +
                    COALESCE(octet_length(item_key_nonce), 0)
                ), 0)::bigint as sum
                FROM item_history
                WHERE user_id = ${u.id}
            `);
            const historySum = Number(historyResult?.sum ?? 0);

            // storage_used_trash — TRASHED (deleted_at IS NOT NULL) file blobs **and** the payload
            // bytes of trashed items. An earlier comment claimed that
            // "items in Trash have no payload" — untrue: a soft delete KEEPS the ciphertext (it is
            // needed for display and restore), so those bytes have to be counted. The formula must
            // stay identical to the one in `gc.ts` (`runDeepRepair`), otherwise two reconstructors
            // produce different results.
            const [trashBlobResult] = await tx.execute(sql`
                SELECT COALESCE(SUM(cs.total_size), 0)::bigint as sum
                FROM chunk_sets cs
                WHERE cs.user_id = ${u.id}
                  AND cs.pending_delete_at IS NULL
                  AND EXISTS (
                      SELECT 1 FROM items i
                      WHERE i.chunk_set_id = cs.id
                        AND i.user_id = cs.user_id
                        AND i.deleted_at IS NOT NULL
                        AND i.purged_at IS NULL
                  )
            `);
            const [trashPayloadResult] = await tx.execute(sql`
                SELECT COALESCE(SUM(
                    COALESCE(octet_length(encrypted_payload), 0) +
                    COALESCE(octet_length(encrypted_item_key), 0) +
                    COALESCE(octet_length(payload_nonce), 0) +
                    COALESCE(octet_length(item_key_nonce), 0)
                ), 0)::bigint as sum
                FROM items
                WHERE user_id = ${u.id}
                  AND deleted_at IS NOT NULL
                  AND purged_at IS NULL
                  AND encrypted_payload IS NOT NULL
            `);
            const trashSum =
                Number(trashBlobResult?.sum ?? 0) + Number(trashPayloadResult?.sum ?? 0);

            await tx.execute(sql`
                UPDATE users
                SET storage_used_files = ${filesSum},
                    storage_used_items = ${itemsSum},
                    storage_used_history = ${historySum},
                    storage_used_trash = ${trashSum}
                WHERE id = ${u.id}
            `);

            console.log(
                `User ${u.id}: files=${filesSum}, items=${itemsSum}, history=${historySum}, trash=${trashSum}`,
            );
        });
    }

    console.log("Backfill completed!");
    process.exit(0);
}

main().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
});
