// Regression: a crop swap must neither delete a conflict copy's shared blob nor leak quota.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { items, users } from "../../src/db/schema";
import {
    createTestUser,
    filePayload,
    getChunkSetPendingDeleteAt,
    getUserIdByEmail,
    getUserStorageUsed,
    insertChunkSet,
    resetDb,
} from "../helpers";

const FILE_SIZE = 1000;

let app: FastifyInstance;
let cookie: string;
let userEmail: string;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    await resetDb();
    ({ cookie, email: userEmail } = await createTestUser(app));
});

async function seedConflictPair(): Promise<{
    itemAId: string;
    itemAPrimeId: string;
    chunkSetX: string;
}> {
    const userId = await getUserIdByEmail(userEmail);
    if (!userId) throw new Error("user not found");

    const chunkSetX = uuidv7();
    await insertChunkSet(chunkSetX, userId, { totalSize: FILE_SIZE });
    await db.update(users).set({ storage_used_files: FILE_SIZE }).where(eq(users.id, userId));

    const itemAId = uuidv7();
    const itemAPrimeId = uuidv7();

    for (const id of [itemAId, itemAPrimeId]) {
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(id, chunkSetX),
        });
        if (res.statusCode !== 201) {
            throw new Error(`create file failed (${res.statusCode}): ${res.body}`);
        }
    }

    return { itemAId, itemAPrimeId, chunkSetX };
}

async function cropViaBatch(itemId: string, newChunkSet: string, version: number): Promise<void> {
    const res = await app.inject({
        method: "POST",
        url: "/items/batch",
        headers: { cookie },
        payload: {
            upsert: [
                filePayload(itemId, newChunkSet, {
                    version,
                    chunk_count: 1,
                    ciphertext_size: 64,
                }),
            ],
            delete_ids: [],
        },
    });
    if (res.statusCode !== 200) {
        throw new Error(`batch crop failed (${res.statusCode}): ${res.body}`);
    }
}

async function trashAndPurge(itemId: string): Promise<void> {
    const del = await app.inject({
        method: "DELETE",
        url: `/items/${itemId}`,
        headers: { cookie },
    });
    expect(del.statusCode).toBe(200);

    const purge = await app.inject({
        method: "DELETE",
        url: `/items/${itemId}/purge`,
        headers: { cookie },
    });
    expect(purge.statusCode).toBe(200);
}

describe("a crop swap with a conflict copy", () => {
    test("a shared chunk set survives a crop while another copy still references it", async () => {
        const userId = await getUserIdByEmail(userEmail);
        if (!userId) throw new Error("user not found");

        const { itemAId, itemAPrimeId, chunkSetX } = await seedConflictPair();
        const chunkSetY = uuidv7();
        await insertChunkSet(chunkSetY, userId, { totalSize: FILE_SIZE });

        await cropViaBatch(itemAId, chunkSetY, 1);

        expect(await getChunkSetPendingDeleteAt(chunkSetX)).toBeNull();
        // X still references A′ — the quota must not shrink during the crop
        expect(await getUserStorageUsed(userEmail)).toBe(FILE_SIZE);

        await trashAndPurge(itemAPrimeId);

        expect(await getChunkSetPendingDeleteAt(chunkSetX)).toBeGreaterThan(0);
        // X is released; Y was never reserved in this test (DB seed only)
        expect(await getUserStorageUsed(userEmail)).toBe(0);
    });

    test("a normal crop (with no copy) marks the old set at once and releases the quota", async () => {
        const userId = await getUserIdByEmail(userEmail);
        if (!userId) throw new Error("user not found");

        const chunkSetX = uuidv7();
        await insertChunkSet(chunkSetX, userId, { totalSize: FILE_SIZE });
        await db.update(users).set({ storage_used_files: FILE_SIZE }).where(eq(users.id, userId));

        const itemId = uuidv7();
        const create = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(itemId, chunkSetX),
        });
        expect(create.statusCode).toBe(201);

        const chunkSetY = uuidv7();
        await insertChunkSet(chunkSetY, userId, { totalSize: FILE_SIZE });
        await db
            .update(users)
            .set({ storage_used_files: FILE_SIZE * 2 })
            .where(eq(users.id, userId));

        await cropViaBatch(itemId, chunkSetY, 1);

        expect(await getChunkSetPendingDeleteAt(chunkSetX)).toBeGreaterThan(0);
        expect(await getUserStorageUsed(userEmail)).toBe(FILE_SIZE);

        const [row] = await db.select().from(items).where(eq(items.id, itemId));
        expect(row?.chunk_set_id).toBe(chunkSetY);
    });
});
