// An item's payload bytes are counted in the trash bucket while it is in the trash. A PUT on a
// trashed item used to put its size change into the items bucket: the total stayed right, the
// split did not, until the weekly deep repair.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { items } from "../../src/db/schema";
import {
    createTestUser,
    getUserStorageUsedItems,
    getUserStorageUsedTrash,
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

describe("PUT /items/:id on an item in the trash", () => {
    test("the size change goes to the trash bucket", async () => {
        const id = uuidv7();
        expect(
            (
                await app.inject({
                    method: "POST",
                    url: "/items",
                    headers: { cookie },
                    payload: notePayload(id),
                })
            ).statusCode,
        ).toBe(201);
        expect(
            (await app.inject({ method: "DELETE", url: `/items/${id}`, headers: { cookie } }))
                .statusCode,
        ).toBe(200);
        const [row] = await db
            .select({ version: items.version, deleted_at: items.deleted_at })
            .from(items)
            .where(eq(items.id, id));
        const itemsBefore = await getUserStorageUsedItems(email);
        const trashBefore = await getUserStorageUsedTrash(email);

        const bigger = Buffer.alloc(100, 7).toString("base64");
        const res = await app.inject({
            method: "PUT",
            url: `/items/${id}`,
            headers: { cookie },
            payload: {
                ...notePayload(id, { encrypted_payload: bigger }),
                version: row?.version,
                deleted_at: row?.deleted_at,
            },
        });
        expect(res.statusCode).toBe(200);

        expect(await getUserStorageUsedItems(email)).toBe(itemsBefore);
        expect(await getUserStorageUsedTrash(email)).toBeGreaterThan(trashBefore);
    });
});
