// An item's type is fixed when it is created. The cycle check for folder moves used to trust the
// type the client sent: an existing folder updated "as a note" skipped the check, so a folder could
// be moved under its own child.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { items } from "../../src/db/schema";
import { createTestUser, folderPayload, notePayload, resetDb } from "../helpers";

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    await resetDb();
    ({ cookie } = await createTestUser(app));
});

async function batch(upsert: unknown[]) {
    const res = await app.inject({
        method: "POST",
        url: "/items/batch",
        headers: { cookie },
        payload: { upsert, delete_ids: [] },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
        succeeded: { id: string }[];
        errors: { id: string; error: string }[];
    };
}

async function stored(id: string) {
    const [row] = await db
        .select({ type: items.type, parent_id: items.parent_id })
        .from(items)
        .where(eq(items.id, id));
    return row;
}

describe("POST /items/batch — the stored type decides", () => {
    test("a folder updated as a note cannot move under its own child", async () => {
        const a = uuidv7();
        const b = uuidv7();
        await batch([folderPayload(a), folderPayload(b, a)]);

        const body = await batch([notePayload(a, { parent_id: b, version: 1 })]);

        expect(body.errors).toEqual([{ id: a, error: "item_type_mismatch" }]);
        expect(await stored(a)).toEqual({ type: "folder", parent_id: null });
    });

    test("a note updated as a folder is refused and stays a note", async () => {
        const n = uuidv7();
        await batch([notePayload(n)]);

        const body = await batch([folderPayload(n, null, { version: 1 })]);

        expect(body.errors).toEqual([{ id: n, error: "item_type_mismatch" }]);
        expect((await stored(n))?.type).toBe("note");
    });

    test("the rest of the batch still goes through", async () => {
        const a = uuidv7();
        const b = uuidv7();
        const other = uuidv7();
        await batch([folderPayload(a), folderPayload(b, a)]);

        const body = await batch([
            notePayload(a, { parent_id: b, version: 1 }),
            notePayload(other),
        ]);

        expect(body.succeeded.map((s) => s.id)).toEqual([other]);
        expect(body.errors.map((e) => e.id)).toEqual([a]);
    });

    test("a same-type update still moves a folder, and a real cycle is still refused", async () => {
        const a = uuidv7();
        const b = uuidv7();
        const c = uuidv7();
        await batch([folderPayload(a), folderPayload(b, a), folderPayload(c)]);

        await batch([folderPayload(c, a, { version: 1 })]);
        expect((await stored(c))?.parent_id).toBe(a);

        const cycle = await app.inject({
            method: "POST",
            url: "/items/batch",
            headers: { cookie },
            payload: { upsert: [folderPayload(a, b, { version: 1 })], delete_ids: [] },
        });
        expect(cycle.statusCode).toBe(400);
        expect(cycle.json().error).toBe("Cycle detected in folder hierarchy");
    });
});
