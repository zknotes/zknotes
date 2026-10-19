import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import {
    createSeededFileItem,
    createTestUser,
    filePayload,
    getChunkSetPendingDeleteAt,
    getUserIdByEmail,
    getUserStorageUsed,
    insertChunkSet,
    notePayload,
    resetDb,
} from "../helpers";

// Binding a chunk set that sits in `pending_delete` (its original was purged, the blob is still
// there) brings the set back AND puts its bytes into the files bucket again. Create always did
// both; the two update paths reclaimed through a predicate with a side effect and never re-charged,
// so the counter under-reported until the weekly deep repair (saas spec 154, finding 1.8).

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

async function pendingSet(size: number): Promise<string> {
    const userId = await getUserIdByEmail(email);
    if (!userId) throw new Error("test user missing");
    const id = uuidv7();
    await insertChunkSet(id, userId, {
        pendingDeleteAt: Math.floor(Date.now() / 1000),
        totalSize: size,
    });
    return id;
}

describe("re-binding a pending_delete chunk set", () => {
    test("PUT /items/:id onto a pending set reclaims it and re-charges the files bucket", async () => {
        const { itemId } = await createSeededFileItem(app, cookie, email, 500);
        const before = await getUserStorageUsed(email);
        const pending = await pendingSet(1000);

        const res = await app.inject({
            method: "PUT",
            url: `/items/${itemId}`,
            headers: { cookie },
            payload: { version: 1, chunk_set_id: pending },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().chunk_set_id).toBe(pending);
        expect(await getChunkSetPendingDeleteAt(pending)).toBeNull();
        // The old 500-byte set is released (no other reference), the reclaimed 1000 are charged.
        expect(await getUserStorageUsed(email)).toBe(before - 500 + 1000);
    });

    test("POST /items/batch update onto a pending set does the same", async () => {
        const { itemId } = await createSeededFileItem(app, cookie, email, 500);
        const before = await getUserStorageUsed(email);
        const pending = await pendingSet(700);

        const res = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: {
                upsert: [filePayload(itemId, pending, { version: 1 })],
                delete_ids: [],
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().errors ?? []).toEqual([]);
        expect(await getChunkSetPendingDeleteAt(pending)).toBeNull();
        expect(await getUserStorageUsed(email)).toBe(before - 500 + 700);
    });

    test("a note cannot bind a chunk set, and an unknown set is still a 409", async () => {
        const noteId = uuidv7();
        const created = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(noteId),
        });
        expect(created.statusCode).toBe(201);
        const asNote = await app.inject({
            method: "PUT",
            url: `/items/${noteId}`,
            headers: { cookie },
            payload: { version: 1, chunk_set_id: await pendingSet(10) },
        });
        expect(asNote.statusCode).toBe(409);

        const { itemId } = await createSeededFileItem(app, cookie, email, 100);
        const unknown = await app.inject({
            method: "PUT",
            url: `/items/${itemId}`,
            headers: { cookie },
            payload: { version: 1, chunk_set_id: uuidv7() },
        });
        expect(unknown.statusCode).toBe(409);
        expect(unknown.json().error).toBe("Referenced chunk set is not committed");
    });

    test("create on a pending set still re-charges (unchanged behaviour)", async () => {
        const before = await getUserStorageUsed(email);
        const pending = await pendingSet(300);
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(uuidv7(), pending),
        });
        expect(res.statusCode).toBe(201);
        expect(await getUserStorageUsed(email)).toBe(before + 300);
    });
});
