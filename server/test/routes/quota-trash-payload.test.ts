// A note's content in Trash has to consume quota, exactly like a file's blob in Trash.
//
// Before: trashing reduced `storage_used_items` by the full payload size while the ciphertext stayed
// in the database — the bytes exist, but the quota counted them as 0.
// Now: the payload moves `items → trash`, a restore moves it back `trash → items`, and a purge
// releases it from whichever bucket it was in.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { users } from "../../src/db/schema";
import { runDeepRepair } from "../../src/gc";
import { createTestUser, db, notePayload, resetDb } from "../helpers";

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

interface Counters {
    items: number;
    trash: number;
    total: number;
}

async function counters(): Promise<Counters> {
    const [row] = await db
        .select({
            items: users.storage_used_items,
            trash: users.storage_used_trash,
            total: users.storage_used,
        })
        .from(users)
        .where(eq(users.email, userEmail))
        .limit(1);
    return {
        items: Number(row?.items ?? 0),
        trash: Number(row?.trash ?? 0),
        total: Number(row?.total ?? 0),
    };
}

async function createNote(id = uuidv7()): Promise<string> {
    const res = await app.inject({
        method: "POST",
        url: "/items",
        headers: { cookie },
        payload: notePayload(id),
    });
    expect(res.statusCode).toBe(201);
    return id;
}

async function trashViaDelete(id: string) {
    const res = await app.inject({ method: "DELETE", url: `/items/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
}

async function batch(payload: Record<string, unknown>) {
    const res = await app.inject({
        method: "POST",
        url: "/items/batch",
        headers: { cookie },
        payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
}

describe("quota — a trashed payload enters storage_used_trash", () => {
    test("DELETE /items/:id moves the payload items → trash, leaving the total unchanged", async () => {
        const id = await createNote();
        const before = await counters();
        expect(before.items).toBeGreaterThan(0);

        await trashViaDelete(id);

        const after = await counters();
        expect(after.items).toBe(0);
        expect(after.trash).toBe(before.items);
        // The key point: the content still physically exists, so the total usage must NOT shrink.
        expect(after.total).toBe(before.total);
    });

    test("a restore moves trash → items with no drift across the cycle", async () => {
        const id = await createNote();
        const before = await counters();

        await trashViaDelete(id);
        // The restore goes through a batch upsert with deleted_at: null (the same path the client takes).
        await batch({
            upsert: [notePayload(id, { version: 2, deleted_at: null })],
            delete_ids: [],
        });

        const after = await counters();
        expect(after.items).toBe(before.items);
        expect(after.trash).toBe(0);
        expect(after.total).toBe(before.total);
    });

    test("a purge from Trash releases the trash counter", async () => {
        const id = await createNote();
        await trashViaDelete(id);
        expect((await counters()).trash).toBeGreaterThan(0);

        await batch({ upsert: [], delete_ids: [id] });

        const after = await counters();
        expect(after.trash).toBe(0);
        expect(after.items).toBe(0);
        expect(after.total).toBe(0);
    });

    test("a direct purge of a READY note releases the items counter (closing a pre-existing leak)", async () => {
        const id = await createNote();
        expect((await counters()).items).toBeGreaterThan(0);

        // delete_ids with no prior trash — a supported contract (purgeItemTx sets deleted_at itself).
        await batch({ upsert: [], delete_ids: [id] });

        const after = await counters();
        expect(after.items).toBe(0);
        expect(after.trash).toBe(0);
        expect(after.total).toBe(0);
    });

    test("editing the payload while the item is in Trash moves the trash counter", async () => {
        const id = await createNote();
        await trashViaDelete(id);
        const afterTrash = await counters();

        // A larger payload, still trashed (deleted_at stays set).
        const bigger = "x".repeat(400);
        await batch({
            upsert: [
                notePayload(id, {
                    version: 2,
                    deleted_at: Math.floor(Date.now() / 1000) - 10,
                    encrypted_payload: Buffer.from(bigger).toString("base64"),
                }),
            ],
            delete_ids: [],
        });

        const after = await counters();
        expect(after.items).toBe(0);
        expect(after.trash).toBeGreaterThan(afterTrash.trash);
    });

    test("runDeepRepair reconstructs the same counters as the incremental path", async () => {
        const kept = await createNote();
        const trashed = await createNote();
        const purged = await createNote();

        await trashViaDelete(trashed);
        await trashViaDelete(purged);
        await batch({ upsert: [], delete_ids: [purged] });

        const incremental = await counters();
        expect(incremental.trash).toBeGreaterThan(0);
        expect(incremental.items).toBeGreaterThan(0);

        await runDeepRepair();

        const reconciled = await counters();
        expect(reconciled.items).toBe(incremental.items);
        expect(reconciled.trash).toBe(incremental.trash);
        expect(reconciled.total).toBe(incremental.total);
        expect(kept).toBeTruthy();
    });
});
