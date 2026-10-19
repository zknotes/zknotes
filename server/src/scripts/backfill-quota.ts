import { db } from "../db";
import { users } from "../db/schema";
import { recomputeUserQuota } from "../services/quota-service";

// console.log is kept for this backfill script

async function main() {
    console.log("Starting quota backfill...");

    const allUsers = await db.select({ id: users.id }).from(users);
    console.log(`Found ${allUsers.length} users to backfill.`);

    for (const u of allUsers) {
        console.log(`Processing user ${u.id}...`);
        // The same reconstruction the weekly deep repair runs (one formula, in the quota service).
        const q = await db.transaction((tx) => recomputeUserQuota(tx, u.id));
        console.log(
            `User ${u.id}: files=${q.files}, items=${q.items}, history=${q.history}, trash=${q.trash}`,
        );
    }

    console.log("Backfill completed!");

    process.exit(0);
}

main().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
});
