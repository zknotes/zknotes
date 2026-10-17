// What a restore may do to the existing tree and its blobs: it cannot change an item's type, a
// staged item's parent has to be the right kind, and the chunk sets it replaces are released only
// when nothing else still references them.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { chunkSets, items } from "../../src/db/schema";
import {
    createTestUser,
    filePayload,
    folderPayload,
    getChunkSetPendingDeleteAt,
    getUserIdByEmail,
    getUserStorageUsed,
    getUserStorageUsedTrash,
    insertChunkSet,
    notePayload,
    resetDb,
} from "../helpers";

const FILE_SIZE = 1000;

let app: FastifyInstance;
let cookie: string;
let email: string;
let userId: string;

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
    const id = await getUserIdByEmail(email);
    if (!id) throw new Error("user not found");
    userId = id;
});

type Kind = "note" | "folder" | "file";

async function post(url: string, payload?: unknown) {
    return app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });
}

async function openOverwrite(manifest: { id: string; type: Kind; parent_id: string | null }[]) {
    const res = await post("/restore/sessions", {
        backup_hash: "b".repeat(64),
        manifest: manifest.map((m) => ({ ...m, byte_size: 16 })),
        mode: "overwrite_all",
    });
    expect(res.statusCode).toBe(201);
    return res.json().restore_session_id as string;
}

async function stage(sessionId: string, payloads: unknown[]) {
    const res = await post(`/restore/sessions/${sessionId}/items`, { items: payloads });
    expect(res.statusCode).toBe(200);
}

/** A chunk set the restore uploaded, as the upload commit leaves it. */
async function stagedChunkSet(sessionId: string, totalSize = FILE_SIZE): Promise<string> {
    const id = uuidv7();
    await db.insert(chunkSets).values({
        id,
        user_id: userId,
        chunk_count: 1,
        total_size: totalSize,
        restore_session_id: sessionId,
    });
    return id;
}

/** A live file item with its own committed chunk set, charged to the files bucket. */
async function liveFile(chunkSetId?: string): Promise<{ itemId: string; chunkSetId: string }> {
    const cs = chunkSetId ?? uuidv7();
    if (!chunkSetId) {
        await insertChunkSet(cs, userId, { totalSize: FILE_SIZE });
        await db.execute(
            `UPDATE users SET storage_used_files = storage_used_files + ${FILE_SIZE} WHERE id = '${userId}'` as never,
        );
    }
    const itemId = uuidv7();
    const res = await post("/items", filePayload(itemId, cs));
    expect(res.statusCode).toBe(201);
    return { itemId, chunkSetId: cs };
}

async function commit(sessionId: string) {
    return post(`/restore/sessions/${sessionId}/commit`, {});
}

async function storedType(id: string) {
    const [row] = await db.select({ type: items.type }).from(items).where(eq(items.id, id));
    return row?.type;
}

describe("a restore cannot change an item's type", () => {
    test("a live folder in the tree cannot come back as a note", async () => {
        const e = uuidv7();
        const f = uuidv7();
        expect((await post("/items", folderPayload(e))).statusCode).toBe(201);
        expect((await post("/items", folderPayload(f, e))).statusCode).toBe(201);

        const sessionId = await openOverwrite([{ id: e, type: "note", parent_id: null }]);
        await stage(sessionId, [notePayload(e)]);

        const res = await commit(sessionId);
        expect(res.statusCode).toBe(409);
        const codes = (res.json().blockers as { code: string }[]).map((b) => b.code);
        expect(codes).toContain("item_type_changed");
        expect(await storedType(e)).toBe("folder");
    });

    test("a folder in the trash cannot come back as a note either", async () => {
        const e = uuidv7();
        expect((await post("/items", folderPayload(e))).statusCode).toBe(201);
        expect(
            (await app.inject({ method: "DELETE", url: `/items/${e}`, headers: { cookie } }))
                .statusCode,
        ).toBe(200);

        const sessionId = await openOverwrite([{ id: e, type: "note", parent_id: null }]);
        await stage(sessionId, [notePayload(e)]);

        const res = await commit(sessionId);
        expect(res.statusCode).toBe(409);
        expect(await storedType(e)).toBe("folder");
    });

    test("a staged note cannot sit under a staged note", async () => {
        const parent = uuidv7();
        const child = uuidv7();
        const sessionId = await openOverwrite([
            { id: parent, type: "note", parent_id: null },
            { id: child, type: "note", parent_id: parent },
        ]);
        await stage(sessionId, [notePayload(parent), notePayload(child, { parent_id: parent })]);

        const res = await commit(sessionId);
        expect(res.statusCode).toBe(409);
        expect(await storedType(child)).toBeUndefined();
    });

    test("a staged note cannot sit under an existing note", async () => {
        const parent = uuidv7();
        const child = uuidv7();
        expect((await post("/items", notePayload(parent))).statusCode).toBe(201);

        const sessionId = await openOverwrite([{ id: child, type: "note", parent_id: parent }]);
        await stage(sessionId, [notePayload(child, { parent_id: parent })]);

        expect((await commit(sessionId)).statusCode).toBe(409);
    });

    test("a staged file belongs under a note, not directly in a folder", async () => {
        const note = uuidv7();
        const inNote = uuidv7();
        const ok = await openOverwrite([
            { id: note, type: "note", parent_id: null },
            { id: inNote, type: "file", parent_id: note },
        ]);
        await stage(ok, [
            notePayload(note),
            filePayload(inNote, await stagedChunkSet(ok), { parent_id: note }),
        ]);
        expect((await commit(ok)).statusCode).toBe(200);

        const folder = uuidv7();
        const inFolder = uuidv7();
        const bad = await openOverwrite([
            { id: folder, type: "folder", parent_id: null },
            { id: inFolder, type: "file", parent_id: folder },
        ]);
        await stage(bad, [
            folderPayload(folder),
            filePayload(inFolder, await stagedChunkSet(bad), { parent_id: folder }),
        ]);
        const res = await commit(bad);
        expect(res.statusCode).toBe(409);
        expect((res.json().blockers as { code: string }[]).map((b) => b.code)).toContain(
            "orphan_parent",
        );
    });
});

describe("a restore releases a replaced chunk set only when nothing references it", () => {
    test("a conflict copy that shares the old set keeps it", async () => {
        const original = await liveFile();
        await liveFile(original.chunkSetId); // the conflict copy, sharing the set by design

        const sessionId = await openOverwrite([
            { id: original.itemId, type: "file", parent_id: null },
        ]);
        const newSet = await stagedChunkSet(sessionId);
        await stage(sessionId, [filePayload(original.itemId, newSet)]);

        const filesBefore = await getUserStorageUsed(email);
        expect((await commit(sessionId)).statusCode).toBe(200);

        // Still referenced by the copy: not scheduled for deletion, and still counted.
        expect(await getChunkSetPendingDeleteAt(original.chunkSetId)).toBeNull();
        expect(await getUserStorageUsed(email)).toBe(filesBefore);
    });

    test("a set two restored files shared is released — and its bytes freed — once", async () => {
        // An unrelated file keeps the counter above zero, so a double subtraction cannot hide
        // behind the floor of 0.
        await liveFile();
        const a = await liveFile();
        const b = await liveFile(a.chunkSetId);

        const sessionId = await openOverwrite([
            { id: a.itemId, type: "file", parent_id: null },
            { id: b.itemId, type: "file", parent_id: null },
        ]);
        const setA = await stagedChunkSet(sessionId);
        const setB = await stagedChunkSet(sessionId);
        await stage(sessionId, [filePayload(a.itemId, setA), filePayload(b.itemId, setB)]);

        const filesBefore = await getUserStorageUsed(email);
        expect((await commit(sessionId)).statusCode).toBe(200);

        expect(await getChunkSetPendingDeleteAt(a.chunkSetId)).not.toBeNull();
        expect(await getUserStorageUsed(email)).toBe(filesBefore - FILE_SIZE);
    });

    // The bucket comes from the replaced item, not from a lookup: after the overwrite no item
    // references the old set any more, so a lookup would read "live" and free it from files.
    test("a replaced set that was in the trash is freed from the trash bucket", async () => {
        const original = await liveFile();
        expect(
            (
                await app.inject({
                    method: "DELETE",
                    url: `/items/${original.itemId}`,
                    headers: { cookie },
                })
            ).statusCode,
        ).toBe(200);
        const trashBefore = await getUserStorageUsedTrash(email);
        const filesBefore = await getUserStorageUsed(email);
        expect(trashBefore).toBeGreaterThanOrEqual(FILE_SIZE);

        const sessionId = await openOverwrite([
            { id: original.itemId, type: "file", parent_id: null },
        ]);
        const newSet = await stagedChunkSet(sessionId);
        await stage(sessionId, [filePayload(original.itemId, newSet)]);
        expect((await commit(sessionId)).statusCode).toBe(200);

        expect(await getChunkSetPendingDeleteAt(original.chunkSetId)).not.toBeNull();
        // The item was the only thing in the trash, and the restore brings it back: its blob and
        // its payload both leave the trash bucket, and nothing leaves files.
        expect(await getUserStorageUsedTrash(email)).toBe(0);
        expect(await getUserStorageUsed(email)).toBe(filesBefore);
    });
});

describe("a chunk set staged by a restore belongs to that restore until it commits", () => {
    test("an ordinary item cannot bind itself to it", async () => {
        const note = uuidv7();
        const sessionId = await openOverwrite([{ id: note, type: "note", parent_id: null }]);
        const staged = await stagedChunkSet(sessionId);

        const res = await post("/items", filePayload(uuidv7(), staged));
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("Referenced chunk set is not committed");
    });

    test("aborting the restore leaves alone a staged set that a live item references", async () => {
        const note = uuidv7();
        const sessionId = await openOverwrite([{ id: note, type: "note", parent_id: null }]);
        const staged = await stagedChunkSet(sessionId);
        // A reference that slipped in some other way (the route above refuses it).
        await db.insert(items).values({
            ...filePayloadRow(uuidv7(), staged),
            user_id: userId,
        });

        const res = await post(`/restore/sessions/${sessionId}/abort`);
        expect(res.statusCode).toBe(200);
        expect(await getChunkSetPendingDeleteAt(staged)).toBeNull();
    });

    // The refused reference used to take the aborted restore's set back out of pending delete on
    // its way to the 409, and the batch committed that: the next GC released the set (and its
    // quota) a second time.
    test("a refused reference to an aborted restore's set leaves it scheduled for deletion", async () => {
        const note = uuidv7();
        const sessionId = await openOverwrite([{ id: note, type: "note", parent_id: null }]);
        const staged = await stagedChunkSet(sessionId);
        expect((await post(`/restore/sessions/${sessionId}/abort`)).statusCode).toBe(200);
        expect(await getChunkSetPendingDeleteAt(staged)).not.toBeNull();

        const res = await post("/items/batch", {
            upsert: [{ ...filePayload(uuidv7(), staged), version: 1 }],
            delete_ids: [],
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().errors).toHaveLength(1);
        expect(await getChunkSetPendingDeleteAt(staged)).not.toBeNull();
    });
});

describe("staging more than 2 GiB of files", () => {
    test("the session's reserved bytes are summed without an integer overflow", async () => {
        const note = uuidv7();
        const sessionId = await openOverwrite([{ id: note, type: "note", parent_id: null }]);
        await stagedChunkSet(sessionId, 3 * 1024 ** 3);
        await stage(sessionId, [notePayload(note)]);

        const res = await post(`/restore/sessions/${sessionId}/verify`, {});
        expect(res.statusCode).toBe(200);
    });
});

/** The database row of a file item, for inserting one past the API. */
function filePayloadRow(id: string, chunkSetId: string) {
    const p = filePayload(id, chunkSetId);
    return {
        id,
        type: "file",
        parent_id: null,
        encrypted_payload: Buffer.from(p.encrypted_payload, "base64"),
        payload_nonce: Buffer.from(p.payload_nonce, "base64"),
        encrypted_item_key: Buffer.from(p.encrypted_item_key, "base64"),
        item_key_nonce: Buffer.from(p.item_key_nonce, "base64"),
        sort_order: "m",
        version: 1,
        chunk_set_id: chunkSetId,
        chunk_count: 1,
        ciphertext_size: 19,
    };
}
