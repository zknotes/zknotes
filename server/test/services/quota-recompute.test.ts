import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import { recomputeUserQuota } from "../../src/services/quota-service";
import {
    createSeededFileItem,
    createTestUser,
    getUserIdByEmail,
    getUserStorageUsed,
    getUserStorageUsedItems,
    getUserStorageUsedTrash,
    notePayload,
    resetDb,
} from "../helpers";

// One reconstruction of the four counters (saas spec 154): the weekly deep repair and the operator's
// backfill script both used to carry the seven queries themselves, with a comment asking that the
// copies stay identical. The function must agree with what the write paths maintained, and must
// repair counters that were corrupted.

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let email: string;

beforeAll(async () => {
    app = await buildApp({ logger: false });
});
afterAll(async () => {
    await app.close();
});
beforeEach(async () => {
    await resetDb();
    ({ cookie, email } = await createTestUser(app));
});

async function counters() {
    return {
        files: await getUserStorageUsed(email),
        items: await getUserStorageUsedItems(email),
        trash: await getUserStorageUsedTrash(email),
    };
}

describe("recomputeUserQuota", () => {
    test("agrees with the counters the write paths maintained, and repairs corrupted ones", async () => {
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("test user missing");

        // A live file, a trashed file, a live note and a trashed note.
        await createSeededFileItem(app, cookie, email, 1200);
        const trashedFile = await createSeededFileItem(app, cookie, email, 800);
        const liveNote = uuidv7();
        const trashedNote = uuidv7();
        for (const id of [liveNote, trashedNote]) {
            const res = await app.inject({
                method: "POST",
                url: "/items",
                headers: { cookie },
                payload: notePayload(id),
            });
            expect(res.statusCode).toBe(201);
        }
        for (const id of [trashedFile.itemId, trashedNote]) {
            const res = await app.inject({
                method: "DELETE",
                url: `/items/${id}`,
                headers: { cookie },
            });
            expect(res.statusCode).toBe(200);
        }

        const maintained = await counters();
        expect(maintained.files).toBe(1200);
        expect(maintained.trash).toBeGreaterThan(800);
        expect(maintained.items).toBeGreaterThan(0);

        const recomputed = await db.transaction((tx) => recomputeUserQuota(tx, userId));
        expect(recomputed).toMatchObject({
            files: maintained.files,
            items: maintained.items,
            trash: maintained.trash,
            history: 0,
        });
        expect(await counters()).toEqual(maintained);

        // Corrupt every counter, then rebuild.
        await db
            .update(users)
            .set({
                storage_used_files: 1,
                storage_used_items: 2,
                storage_used_history: 3,
                storage_used_trash: 4,
            })
            .where(eq(users.id, userId));
        await db.transaction((tx) => recomputeUserQuota(tx, userId));
        expect(await counters()).toEqual(maintained);
    });

    test("an empty vault recomputes to zeros", async () => {
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("test user missing");
        expect(await db.transaction((tx) => recomputeUserQuota(tx, userId))).toEqual({
            files: 0,
            items: 0,
            history: 0,
            trash: 0,
        });
    });
});
