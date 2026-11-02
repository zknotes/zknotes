// The bytes of an item are counted in EXACTLY one bucket — `items`/`files` while live, `trash`
// while in the trash (quotas.md). An item can reach the server already trashed (created and trashed
// offline before the first push); both create paths used to charge it to `items`, so a later purge
// released it from `trash` and `items` stayed inflated until the weekly deep repair. A crop swap
// arriving in the same batch as the trash left the new set in `files`.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import {
    createTestUser,
    filePayload,
    getUserIdByEmail,
    insertChunkSet,
    notePayload,
    resetDb,
} from "../helpers";

let app: FastifyInstance;
let cookie: string;
let email: string;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});
afterAll(async () => {
    await app.close();
});
beforeEach(async () => {
    await resetDb();
    ({ cookie, email } = await createTestUser(app));
});

async function buckets() {
    const [row] = await db
        .select({
            files: users.storage_used_files,
            items: users.storage_used_items,
            history: users.storage_used_history,
            trash: users.storage_used_trash,
        })
        .from(users)
        .where(eq(users.email, email));
    return row!;
}

const payloadBytes = (p: Record<string, unknown>) =>
    Buffer.byteLength(p.encrypted_payload as string, "base64") +
    Buffer.byteLength(p.encrypted_item_key as string, "base64") +
    Buffer.byteLength(p.payload_nonce as string, "base64") +
    Buffer.byteLength(p.item_key_nonce as string, "base64");

/** Seeds a committed set and reserves its bytes in `files`, as the upload open would have. */
async function seedSet(userId: string, size: number): Promise<string> {
    const id = uuidv7();
    await insertChunkSet(id, userId, { totalSize: size });
    await db
        .update(users)
        .set({ storage_used_files: sql`storage_used_files + ${size}` })
        .where(eq(users.id, userId));
    return id;
}

const pastSec = () => Math.floor(Date.now() / 1000) - 60;

describe("an item that arrives on the server already trashed", () => {
    test("POST /items with deleted_at charges the trash bucket, not items", async () => {
        const body = notePayload(uuidv7(), { deleted_at: pastSec() });
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: body,
        });
        expect(res.statusCode).toBe(201);
        const b = await buckets();
        expect(b.trash).toBe(payloadBytes(body));
        expect(b.items).toBe(0);
    });

    test("POST /items/batch upsert with deleted_at charges the trash bucket, not items", async () => {
        const body = notePayload(uuidv7(), { deleted_at: pastSec() });
        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [body], delete_ids: [] },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().succeeded.length).toBe(1);
        const b = await buckets();
        expect(b.trash).toBe(payloadBytes(body));
        expect(b.items).toBe(0);
    });

    test("purging it afterwards leaves every bucket at zero", async () => {
        const id = uuidv7();
        const body = notePayload(id, { deleted_at: pastSec() });
        expect(
            (
                await app.inject({
                    method: "POST",
                    url: "/items",
                    headers: { cookie },
                    payload: body,
                })
            ).statusCode,
        ).toBe(201);
        const purge = await app.inject({
            method: "DELETE",
            url: `/items/${id}/purge`,
            headers: { cookie },
        });
        expect(purge.statusCode).toBe(200);
        const b = await buckets();
        expect(b.items).toBe(0);
        expect(b.trash).toBe(0);
    });

    test("a file item created already trashed moves its blob bytes to trash", async () => {
        const userId = (await getUserIdByEmail(email))!;
        const blob = 1000;
        const csId = await seedSet(userId, blob);
        const noteId = uuidv7();
        expect(
            (
                await app.inject({
                    method: "POST",
                    url: "/items",
                    headers: { cookie },
                    payload: notePayload(noteId),
                })
            ).statusCode,
        ).toBe(201);
        const body = filePayload(uuidv7(), csId, { parent_id: noteId, deleted_at: pastSec() });
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: body,
        });
        expect(res.statusCode).toBe(201);
        const b = await buckets();
        expect(b.files).toBe(0);
        expect(b.trash).toBe(blob + payloadBytes(body));
    });
});

describe("crop swap (new chunk set) in the same batch as the trash", () => {
    test("the old set leaves its bucket once and the new set ends in trash", async () => {
        const userId = (await getUserIdByEmail(email))!;
        const noteId = uuidv7();
        expect(
            (
                await app.inject({
                    method: "POST",
                    url: "/items",
                    headers: { cookie },
                    payload: notePayload(noteId),
                })
            ).statusCode,
        ).toBe(201);
        const sizeA = 1000;
        const sizeB = 3000;
        const setA = await seedSet(userId, sizeA);
        const fileId = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(fileId, setA, { parent_id: noteId }),
        });
        expect(created.statusCode).toBe(201);
        const version = created.json().version as number;
        const fileBytes = payloadBytes(filePayload(fileId, setA));
        const noteBytes = payloadBytes(notePayload(noteId));

        // The crop upload of set B finalised (reserved in files), then one upsert carries both
        // the new set and the trash.
        const setB = await seedSet(userId, sizeB);
        expect((await buckets()).files).toBe(sizeA + sizeB);

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    filePayload(fileId, setB, {
                        parent_id: noteId,
                        version,
                        deleted_at: pastSec(),
                    }),
                ],
                delete_ids: [],
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().succeeded.length).toBe(1);
        const after = await buckets();
        // Set A is released (pending delete) → in no bucket; set B is bound to a trashed file →
        // trash; the note stays live in items.
        expect(after.items).toBe(noteBytes);
        expect(after.files).toBe(0);
        expect(after.trash).toBe(sizeB + fileBytes);
    });

    test("restoring from the trash with a new set keeps the new set in files and releases the old", async () => {
        const userId = (await getUserIdByEmail(email))!;
        const noteId = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(noteId),
        });
        const sizeA = 1000;
        const sizeB = 3000;
        const setA = await seedSet(userId, sizeA);
        const fileId = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(fileId, setA, { parent_id: noteId }),
        });
        let version = created.json().version as number;
        const trashed = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    filePayload(fileId, setA, {
                        parent_id: noteId,
                        version,
                        deleted_at: pastSec(),
                    }),
                ],
                delete_ids: [],
            },
        });
        version = trashed.json().succeeded[0].version as number;
        const fileBytes = payloadBytes(filePayload(fileId, setA));
        const noteBytes = payloadBytes(notePayload(noteId));
        expect(await buckets()).toMatchObject({
            files: 0,
            trash: sizeA + fileBytes,
            items: noteBytes,
        });

        const setB = await seedSet(userId, sizeB);
        const restored = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [
                    filePayload(fileId, setB, { parent_id: noteId, version, deleted_at: null }),
                ],
                delete_ids: [],
            },
        });
        expect(restored.statusCode).toBe(200);
        expect(restored.json().succeeded.length).toBe(1);
        expect(await buckets()).toMatchObject({
            files: sizeB,
            trash: 0,
            items: noteBytes + fileBytes,
        });
    });
});
