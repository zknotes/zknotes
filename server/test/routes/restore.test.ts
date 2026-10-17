import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RESTORE_LIMITS, restoreRemapId, restoreRemapIdAt } from "@zknotes/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { itemHistory, items, restoreSessions } from "../../src/db/schema";
import { runGc } from "../../src/gc";
import {
    countChunkSets,
    createSeededFileItem,
    createTestUser,
    filePayload,
    folderPayload,
    getChunkSetPendingDeleteAt,
    getUserStorageTotal,
    getUserStorageUsed,
    getUserStorageUsedItems,
    notePayload,
    resetDb,
    setUserStorage,
} from "../helpers";

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

const prevFileCount = process.env.MAX_FILE_COUNT;
const prevItemCount = process.env.MAX_ITEMS_COUNT;
afterEach(() => {
    if (prevFileCount === undefined) delete process.env.MAX_FILE_COUNT;
    else process.env.MAX_FILE_COUNT = prevFileCount;
    if (prevItemCount === undefined) delete process.env.MAX_ITEMS_COUNT;
    else process.env.MAX_ITEMS_COUNT = prevItemCount;
});

function manifestItem(
    id: string,
    type: "note" | "folder" | "file",
    parent_id: string | null,
    byte_size: number,
) {
    return { id, type, parent_id, byte_size };
}

async function openRestore(
    manifest: ReturnType<typeof manifestItem>[],
    mode: "skip_existing" | "overwrite_all" = "skip_existing",
    hash = "a".repeat(64),
) {
    return app.inject({
        method: "POST",
        url: "/restore/sessions",
        headers: { cookie },
        payload: { backup_hash: hash, manifest, mode },
    });
}

async function stageNotes(sessionId: string, payloads: ReturnType<typeof notePayload>[]) {
    return app.inject({
        method: "POST",
        url: `/restore/sessions/${sessionId}/items`,
        headers: { cookie },
        payload: { items: payloads },
    });
}

describe("POST /restore/sessions", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/restore/sessions",
            payload: {
                backup_hash: "a".repeat(64),
                manifest: [manifestItem(uuidv7(), "note", null, 16)],
                mode: "skip_existing",
            },
        });
        expect(res.statusCode).toBe(401);
    });

    test("the preflight rejects the FILE_LIMITS ceiling separately from ITEM_LIMITS", async () => {
        process.env.MAX_FILE_COUNT = "2";
        process.env.MAX_ITEMS_COUNT = "100";
        const files = [uuidv7(), uuidv7(), uuidv7()].map((id) =>
            manifestItem(id, "file", null, 64),
        );
        const res = await openRestore(files);
        expect(res.statusCode).toBe(201);
        const body = res.json() as { verdict: { ok: boolean; blockers: Array<{ code: string }> } };
        expect(body.verdict.ok).toBe(false);
        const codes = body.verdict.blockers.map((b) => b.code);
        expect(codes).toContain("file_limit_exceeded");
        expect(codes).not.toContain("item_limit_exceeded");
    });

    test("the preflight rejects the ITEM_LIMITS ceiling separately from FILE_LIMITS", async () => {
        process.env.MAX_ITEMS_COUNT = "2";
        process.env.MAX_FILE_COUNT = "50";
        const notes = [uuidv7(), uuidv7(), uuidv7()].map((id) =>
            manifestItem(id, "note", null, 16),
        );
        const res = await openRestore(notes);
        expect(res.statusCode).toBe(201);
        const body = res.json() as { verdict: { ok: boolean; blockers: Array<{ code: string }> } };
        expect(body.verdict.ok).toBe(false);
        const codes = body.verdict.blockers.map((b) => b.code);
        expect(codes).toContain("item_limit_exceeded");
        expect(codes).not.toContain("file_limit_exceeded");
    });

    test("a second open session → 409 restore_already_open", async () => {
        const first = await openRestore([manifestItem(uuidv7(), "note", null, 16)]);
        expect(first.statusCode).toBe(201);
        const second = await openRestore([manifestItem(uuidv7(), "note", null, 16)]);
        expect(second.statusCode).toBe(409);
        expect(second.json().error).toBe("restore_already_open");
    });

    test("skip_existing + a trashed parent + a purged child → orphan_parent", async () => {
        const folderId = uuidv7();
        const childId = uuidv7();
        expect(
            (
                await app.inject({
                    method: "POST",
                    url: "/items",
                    headers: { cookie },
                    payload: folderPayload(folderId),
                })
            ).statusCode,
        ).toBe(201);
        expect(
            (
                await app.inject({
                    method: "POST",
                    url: "/items",
                    headers: { cookie },
                    payload: notePayload(childId, { parent_id: folderId }),
                })
            ).statusCode,
        ).toBe(201);
        expect(
            (
                await app.inject({
                    method: "DELETE",
                    url: `/items/${childId}`,
                    headers: { cookie },
                })
            ).statusCode,
        ).toBe(200);
        expect(
            (
                await app.inject({
                    method: "DELETE",
                    url: `/items/${childId}/purge`,
                    headers: { cookie },
                })
            ).statusCode,
        ).toBe(200);
        expect(
            (
                await app.inject({
                    method: "DELETE",
                    url: `/items/${folderId}`,
                    headers: { cookie },
                })
            ).statusCode,
        ).toBe(200);

        const res = await openRestore(
            [
                manifestItem(folderId, "folder", null, 8),
                manifestItem(childId, "note", folderId, 16),
            ],
            "skip_existing",
        );
        expect(res.statusCode).toBe(201);
        const body = res.json() as {
            verdict: { ok: boolean; blockers: Array<{ code: string }>; orphan_parents: unknown[] };
        };
        expect(body.verdict.ok).toBe(false);
        expect(body.verdict.blockers.some((b) => b.code === "orphan_parent")).toBe(true);
        expect(body.verdict.orphan_parents.length).toBeGreaterThan(0);
    });
});

describe("staging + abort", () => {
    test("staging an id not in the manifest → 409 not_in_manifest", async () => {
        const inManifest = uuidv7();
        const extra = uuidv7();
        const open = await openRestore([manifestItem(inManifest, "note", null, 16)]);
        expect(open.statusCode).toBe(201);
        const sessionId = open.json().restore_session_id as string;
        const res = await stageNotes(sessionId, [notePayload(extra)]);
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("not_in_manifest");
    });

    test("staging is idempotent by ID and does not duplicate the quota", async () => {
        const noteId = uuidv7();
        const open = await openRestore([manifestItem(noteId, "note", null, 16)]);
        expect(open.statusCode).toBe(201);
        const sessionId = open.json().restore_session_id as string;
        const payload = notePayload(noteId);
        const first = await stageNotes(sessionId, [payload]);
        expect(first.statusCode).toBe(200);
        expect(first.json().staged).toBe(1);
        const usedAfterFirst = await getUserStorageUsedItems(userEmail);
        const second = await stageNotes(sessionId, [payload]);
        expect(second.statusCode).toBe(200);
        expect(second.json().staged).toBe(0);
        expect(second.json().skipped).toBe(1);
        expect(await getUserStorageUsedItems(userEmail)).toBe(usedAfterFirst);
    });

    test("abort returns the quota and leaves no items rows behind", async () => {
        const noteId = uuidv7();
        const usedBefore = await getUserStorageTotal(userEmail);
        const open = await openRestore([manifestItem(noteId, "note", null, 16)]);
        const sessionId = open.json().restore_session_id as string;
        expect((await stageNotes(sessionId, [notePayload(noteId)])).statusCode).toBe(200);
        expect(await getUserStorageUsedItems(userEmail)).toBeGreaterThan(usedBefore);

        const abort = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/abort`,
            headers: { cookie },
        });
        expect(abort.statusCode).toBe(200);
        expect(await getUserStorageTotal(userEmail)).toBe(usedBefore);
        const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(items);
        expect(count?.n ?? 0).toBe(0);
    });
});

describe("a purged id comes back under its remap", () => {
    const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    async function createNote(id: string) {
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id),
        });
        expect(res.statusCode).toBe(201);
    }

    async function trash(id: string) {
        const res = await app.inject({
            method: "DELETE",
            url: `/items/${id}`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
    }

    async function createPurgedNote(id: string) {
        await createNote(id);
        await trash(id);
        const purge = await app.inject({
            method: "DELETE",
            url: `/items/${id}/purge`,
            headers: { cookie },
        });
        expect(purge.statusCode).toBe(200);
    }

    async function openFor(id: string) {
        const open = await openRestore([manifestItem(id, "note", null, 16)], "skip_existing", hash);
        expect(open.statusCode).toBe(201);
        return open.json().restore_session_id as string;
    }

    function expectNotInManifest(res: Awaited<ReturnType<typeof stageNotes>>, ids: string[]) {
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("not_in_manifest");
        expect(res.json().ids).toEqual(ids);
    }

    async function verify(sessionId: string) {
        return app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/verify`,
            headers: { cookie },
            payload: {},
        });
    }

    test("the remap stages, verifies and commits as a new item; the original stays purged", async () => {
        const original = uuidv7();
        await createPurgedNote(original);
        const open = await openRestore(
            [manifestItem(original, "note", null, 16)],
            "skip_existing",
            hash,
        );
        expect(open.statusCode).toBe(201);
        expect(open.json().verdict.collisions.purged).toEqual([original]);
        const sessionId = open.json().restore_session_id as string;
        const remapped = restoreRemapId(hash, original);

        const stage = await stageNotes(sessionId, [
            notePayload(remapped, { remapped_from: original }),
        ]);
        expect(stage.statusCode).toBe(200);
        expect(stage.json().staged).toBe(1);

        const verified = await verify(sessionId);
        expect(verified.statusCode).toBe(200);
        expect(verified.json().ok).toBe(true);

        const commit = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/commit`,
            headers: { cookie },
            payload: {},
        });
        expect(commit.statusCode).toBe(200);
        const [created] = await db.select().from(items).where(eq(items.id, remapped));
        expect(created?.encrypted_payload).not.toBeNull();
        expect(created?.deleted_at).toBeNull();
        expect(created?.purged_at).toBeNull();
        const [old] = await db.select().from(items).where(eq(items.id, original));
        expect(old?.purged_at).not.toBeNull();
    });

    test("an id outside the manifest that names an original outside it too → not_in_manifest", async () => {
        const sessionId = await openFor(uuidv7());
        const stray = uuidv7();
        const res = await stageNotes(sessionId, [notePayload(stray, { remapped_from: uuidv7() })]);
        expectNotInManifest(res, [stray]);
    });

    test("the remap of a manifest id that is live, trashed or unknown → not_in_manifest", async () => {
        const live = uuidv7();
        const trashed = uuidv7();
        const unknown = uuidv7();
        await createNote(live);
        await createNote(trashed);
        await trash(trashed);
        const open = await openRestore(
            [
                manifestItem(live, "note", null, 16),
                manifestItem(trashed, "note", null, 16),
                manifestItem(unknown, "note", null, 16),
            ],
            "overwrite_all",
            hash,
        );
        expect(open.statusCode).toBe(201);
        const sessionId = open.json().restore_session_id as string;
        // The ids are the correct remaps, so only the purge check can refuse them.
        for (const original of [live, trashed, unknown]) {
            const remapped = restoreRemapId(hash, original);
            const res = await stageNotes(sessionId, [
                notePayload(remapped, { remapped_from: original }),
            ]);
            expectNotInManifest(res, [remapped]);
        }
    });

    test("a purged original with an id that is not its remap → not_in_manifest", async () => {
        const original = uuidv7();
        await createPurgedNote(original);
        const sessionId = await openFor(original);
        // A random id, and the remap under another backup's hash.
        for (const wrong of [uuidv7(), restoreRemapId("c".repeat(64), original)]) {
            const res = await stageNotes(sessionId, [
                notePayload(wrong, { remapped_from: original }),
            ]);
            expectNotInManifest(res, [wrong]);
        }
    });

    test("a batch with one unproven id stages nothing and names only that id", async () => {
        const original = uuidv7();
        await createPurgedNote(original);
        const sessionId = await openFor(original);
        const stray = uuidv7();
        const res = await stageNotes(sessionId, [
            notePayload(restoreRemapId(hash, original), { remapped_from: original }),
            notePayload(stray),
        ]);
        expectNotInManifest(res, [stray]);
        const view = await app.inject({
            method: "GET",
            url: `/restore/sessions/${sessionId}`,
            headers: { cookie },
        });
        expect(view.json().staged_items).toBe(0);
    });

    test("until the remap is staged, verify and the session view list it as missing", async () => {
        const original = uuidv7();
        await createPurgedNote(original);
        const sessionId = await openFor(original);
        const remapped = restoreRemapId(hash, original);

        const verified = await verify(sessionId);
        expect(verified.json().ok).toBe(false);
        const incomplete = verified
            .json()
            .blockers.find((b: { code: string }) => b.code === "incomplete_staging");
        expect(incomplete?.missing.items).toEqual([remapped]);

        const view = await app.inject({
            method: "GET",
            url: `/restore/sessions/${sessionId}`,
            headers: { cookie },
        });
        expect(view.json().missing.items).toEqual([remapped]);

        expect(
            (await stageNotes(sessionId, [notePayload(remapped, { remapped_from: original })]))
                .statusCode,
        ).toBe(200);
        expect((await verify(sessionId)).json().ok).toBe(true);
    });
});

describe("restoring the same backup again", () => {
    const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const FROM_BACKUP = "ZnJvbS1iYWNrdXA="; // "from-backup"
    const EDITED = "ZWRpdGVkLWFmdGVy"; // "edited-after"

    function call(
        method: "GET" | "POST" | "PUT" | "DELETE",
        url: string,
        payload?: Record<string, unknown>,
    ) {
        return app.inject({
            method,
            url,
            headers: { cookie },
            ...(payload === undefined ? {} : { payload }),
        });
    }

    async function trash(id: string) {
        expect((await call("DELETE", `/items/${id}`)).statusCode).toBe(200);
    }

    async function purge(id: string) {
        await trash(id);
        expect((await call("DELETE", `/items/${id}/purge`)).statusCode).toBe(200);
    }

    async function open(original: string, mode: "skip_existing" | "overwrite_all") {
        const res = await openRestore([manifestItem(original, "note", null, 16)], mode, hash);
        expect(res.statusCode).toBe(201);
        return {
            sessionId: res.json().restore_session_id as string,
            verdict: res.json().verdict,
        };
    }

    function stage(sessionId: string, id: string, original: string, version = 1) {
        return stageNotes(sessionId, [
            notePayload(id, { remapped_from: original, encrypted_payload: FROM_BACKUP, version }),
        ]);
    }

    async function finish(sessionId: string) {
        return call("POST", `/restore/sessions/${sessionId}/commit`, {});
    }

    async function payloadOf(id: string) {
        const [row] = await db.select().from(items).where(eq(items.id, id));
        return row;
    }

    /** The first restore: the note was purged, so it comes back under generation 0. */
    async function firstRestore(original: string): Promise<string> {
        expect((await call("POST", "/items", notePayload(original))).statusCode).toBe(201);
        await purge(original);
        const { sessionId } = await open(original, "skip_existing");
        const copy = restoreRemapId(hash, original);
        expect((await stage(sessionId, copy, original)).statusCode).toBe(200);
        expect((await finish(sessionId)).statusCode).toBe(200);
        return copy;
    }

    async function edit(id: string, version: number) {
        const res = await call("PUT", `/items/${id}`, {
            ...notePayload(id),
            version,
            encrypted_payload: EDITED,
        });
        expect(res.statusCode).toBe(200);
    }

    test("Skip existing leaves the first restore's copy, edited since, alone", async () => {
        const original = uuidv7();
        const copy = await firstRestore(original);
        await edit(copy, 1);

        const { sessionId, verdict } = await open(original, "skip_existing");
        expect(verdict.counts).toMatchObject({
            creates: 0,
            skips: 1,
            collide_purged: 1,
            collide_remapped: 1,
        });
        expect(verdict.collisions.live).toEqual([copy]);
        expect(verdict.remaps).toEqual({ [original]: copy });
        const view = await call("GET", `/restore/sessions/${sessionId}`);
        expect(view.json().missing.items).toEqual([]);

        expect((await finish(sessionId)).statusCode).toBe(200);
        expect((await payloadOf(copy))?.encrypted_payload?.toString("base64")).toBe(EDITED);
    });

    test("Overwrite all overwrites that copy under its version", async () => {
        const original = uuidv7();
        const copy = await firstRestore(original);
        await edit(copy, 1);

        const { sessionId, verdict } = await open(original, "overwrite_all");
        expect(verdict.counts).toMatchObject({ creates: 0, overwrites: 1, collide_remapped: 1 });
        expect(verdict.expected_versions).toEqual({ [copy]: 2 });
        expect((await stage(sessionId, copy, original, 2)).statusCode).toBe(200);

        expect((await finish(sessionId)).statusCode).toBe(200);
        const row = await payloadOf(copy);
        expect(row?.encrypted_payload?.toString("base64")).toBe(FROM_BACKUP);
        expect(row?.version).toBe(3);
    });

    test("an edit of that copy after the preflight blocks with version_drift", async () => {
        const original = uuidv7();
        const copy = await firstRestore(original);

        const { sessionId } = await open(original, "overwrite_all");
        expect((await stage(sessionId, copy, original)).statusCode).toBe(200);
        await edit(copy, 1);

        const verified = await call("POST", `/restore/sessions/${sessionId}/verify`, {});
        expect(verified.json().ok).toBe(false);
        expect(
            verified.json().blockers.some((b: { code: string }) => b.code === "version_drift"),
        ).toBe(true);
    });

    test("a copy in the Trash stays there under Skip existing and comes back under Overwrite all", async () => {
        const original = uuidv7();
        const copy = await firstRestore(original);
        await trash(copy);

        const skip = await open(original, "skip_existing");
        expect(skip.verdict.counts).toMatchObject({ creates: 0, skips: 1 });
        expect(skip.verdict.collisions.trashed).toEqual([copy]);
        expect((await finish(skip.sessionId)).statusCode).toBe(200);
        expect((await payloadOf(copy))?.deleted_at).not.toBeNull();

        const overwrite = await open(original, "overwrite_all");
        expect(overwrite.verdict.counts).toMatchObject({ creates: 0, overwrites: 1 });
        const version = overwrite.verdict.expected_versions[copy] as number;
        expect((await stage(overwrite.sessionId, copy, original, version)).statusCode).toBe(200);
        expect((await finish(overwrite.sessionId)).statusCode).toBe(200);
        expect((await payloadOf(copy))?.deleted_at).toBeNull();
    });

    test("a copy purged since moves the item on to the next generation", async () => {
        const original = uuidv7();
        const copy = await firstRestore(original);
        await purge(copy);
        const next = restoreRemapIdAt(hash, original, 1);

        const { sessionId, verdict } = await open(original, "skip_existing");
        expect(verdict.remaps).toEqual({ [original]: next });
        expect(verdict.counts).toMatchObject({ creates: 1, collide_remapped: 0 });
        // The purged copy is not a proven remap any more; the next generation is.
        const stale = await stage(sessionId, copy, original);
        expect(stale.statusCode).toBe(409);
        expect(stale.json().ids).toEqual([copy]);
        expect((await stage(sessionId, next, original)).statusCode).toBe(200);

        expect((await finish(sessionId)).statusCode).toBe(200);
        const row = await payloadOf(next);
        expect(row?.purged_at).toBeNull();
        expect(row?.deleted_at).toBeNull();
    });

    test("every generation purged → the preflight blocks with remap_exhausted", async () => {
        const original = uuidv7();
        expect((await call("POST", "/items", notePayload(original))).statusCode).toBe(201);
        await purge(original);
        for (let g = 0; g <= RESTORE_LIMITS.MAX_REMAP_GENERATION; g++) {
            const id = restoreRemapIdAt(hash, original, g);
            expect((await call("POST", "/items", notePayload(id))).statusCode).toBe(201);
            await purge(id);
        }

        const { verdict } = await open(original, "skip_existing");
        expect(verdict.ok).toBe(false);
        expect(verdict.blockers).toContainEqual({ code: "remap_exhausted", items: [original] });
        expect(verdict.remaps).toEqual({});
    });
});

describe("staging does not consume the cap of 5", () => {
    test("an ordinary upload works during restore staging, and the other way round", async () => {
        const noteId = uuidv7();
        const open = await openRestore([manifestItem(noteId, "note", null, 16)]);
        const sessionId = open.json().restore_session_id as string;

        const CHUNK = 64;
        async function openRegular() {
            return app.inject({
                method: "POST",
                url: "/uploads",
                headers: { cookie },
                payload: { expected_chunks: 1, total_size: CHUNK, chunk_sizes: [CHUNK] },
            });
        }
        for (let i = 0; i < 5; i++) {
            expect((await openRegular()).statusCode).toBe(201);
        }
        expect((await openRegular()).statusCode).toBe(429);

        const restoreUpload = await app.inject({
            method: "POST",
            url: "/uploads",
            headers: { cookie },
            payload: {
                expected_chunks: 1,
                total_size: CHUNK,
                chunk_sizes: [CHUNK],
                restore_session_id: sessionId,
            },
        });
        expect(restoreUpload.statusCode).toBe(201);
        expect(restoreUpload.json().chunk_set_id).toBeTruthy();
    });
});

describe("verify + commit", () => {
    test("verify rejects unknown body fields but still accepts an empty body", async () => {
        const id = uuidv7();
        const open = await openRestore([manifestItem(id, "note", null, 16)], "overwrite_all");
        expect(open.statusCode).toBe(201);
        const sessionId = open.json().restore_session_id as string;
        expect((await stageNotes(sessionId, [notePayload(id)])).statusCode).toBe(200);

        const invalid = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/verify`,
            headers: { cookie },
            payload: { foo: 1 },
        });
        expect(invalid.statusCode).toBe(400);

        const valid = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/verify`,
            headers: { cookie },
            payload: {},
        });
        expect(valid.statusCode).toBe(200);
    });

    test("verify with NO body at all (not even {}) still runs and returns the verdict", async () => {
        const id = uuidv7();
        const open = await openRestore([manifestItem(id, "note", null, 16)], "overwrite_all");
        const sessionId = open.json().restore_session_id as string;
        expect((await stageNotes(sessionId, [notePayload(id)])).statusCode).toBe(200);

        const res = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/verify`,
            headers: { cookie },
            // Deliberately without a `payload` — request.body is undefined, not {}. RestoreVerifySchema is
            // it is .optional(), so parseBody legitimately returns undefined on success; `if (!parsed) return`
            // that must not be confused with a failed validation (null).
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().ok).toBe(true);
    });

    test("skip leaves the trash alone, overwrite resurrects", async () => {
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
            (
                await app.inject({
                    method: "DELETE",
                    url: `/items/${id}`,
                    headers: { cookie },
                })
            ).statusCode,
        ).toBe(200);

        const skip = await openRestore([manifestItem(id, "note", null, 16)], "skip_existing");
        expect(skip.json().verdict.counts.skips).toBe(1);
        await app.inject({
            method: "POST",
            url: `/restore/sessions/${skip.json().restore_session_id}/abort`,
            headers: { cookie },
        });

        const overwrite = await openRestore([manifestItem(id, "note", null, 16)], "overwrite_all");
        expect(overwrite.statusCode).toBe(201);
        const sessionId = overwrite.json().restore_session_id as string;
        expect(overwrite.json().verdict.counts.overwrites).toBe(1);
        expect((await stageNotes(sessionId, [notePayload(id)])).statusCode).toBe(200);
        const verify = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/verify`,
            headers: { cookie },
            payload: {},
        });
        expect(verify.statusCode).toBe(200);
        expect(verify.json().ok).toBe(true);
        const commit = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/commit`,
            headers: { cookie },
            payload: {},
        });
        expect(commit.statusCode).toBe(200);
        const [row] = await db.select().from(items).where(eq(items.id, id));
        expect(row?.deleted_at).toBeNull();
        expect(row?.purged_at).toBeNull();
    });

    test("a version drift fails the whole commit", async () => {
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
        const open = await openRestore([manifestItem(id, "note", null, 16)], "overwrite_all");
        const sessionId = open.json().restore_session_id as string;
        expect((await stageNotes(sessionId, [notePayload(id)])).statusCode).toBe(200);

        const bumped = await app.inject({
            method: "PUT",
            url: `/items/${id}`,
            headers: { cookie },
            payload: { ...notePayload(id), version: 1, encrypted_payload: "bmV3cGF5bG9hZA==" },
        });
        expect(bumped.statusCode).toBe(200);

        const verify = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/verify`,
            headers: { cookie },
            payload: {},
        });
        expect(verify.json().ok).toBe(false);
        expect(
            verify.json().blockers.some((b: { code: string }) => b.code === "version_drift"),
        ).toBe(true);

        const commit = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/commit`,
            headers: { cookie },
            payload: {},
        });
        expect(commit.statusCode).toBe(409);
        const [row] = await db.select().from(items).where(eq(items.id, id));
        expect(row?.version).toBe(2);
    });

    test("overwrite_all commit rejects a folder parent cycle", async () => {
        const aId = uuidv7();
        const bId = uuidv7();
        expect(
            (
                await app.inject({
                    method: "POST",
                    url: "/items",
                    headers: { cookie },
                    payload: folderPayload(aId),
                })
            ).statusCode,
        ).toBe(201);
        expect(
            (
                await app.inject({
                    method: "POST",
                    url: "/items",
                    headers: { cookie },
                    payload: folderPayload(bId, aId),
                })
            ).statusCode,
        ).toBe(201);

        const open = await openRestore(
            [manifestItem(aId, "folder", bId, 16), manifestItem(bId, "folder", aId, 16)],
            "overwrite_all",
        );
        expect(open.statusCode).toBe(201);
        const sessionId = open.json().restore_session_id as string;
        const stage = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/items`,
            headers: { cookie },
            payload: {
                items: [
                    folderPayload(aId, bId, { version: 1 }),
                    folderPayload(bId, aId, { version: 1 }),
                ],
            },
        });
        expect(stage.statusCode).toBe(200);

        const commit = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/commit`,
            headers: { cookie },
            payload: {},
        });
        expect(commit.statusCode).toBe(400);
    });

    test("overwrite does not delete item_history", async () => {
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
        const snap = await app.inject({
            method: "POST",
            url: `/items/${id}/history`,
            headers: { cookie },
            payload: {
                item_id: id,
                encrypted_payload: "c25hcHNob3Q=",
                payload_nonce: "A".repeat(32),
                encrypted_item_key: "C".repeat(64),
                item_key_nonce: "B".repeat(32),
                item_version_at_snapshot: 1,
            },
        });
        expect(snap.statusCode).toBe(201);

        const open = await openRestore([manifestItem(id, "note", null, 16)], "overwrite_all");
        const sessionId = open.json().restore_session_id as string;
        expect((await stageNotes(sessionId, [notePayload(id)])).statusCode).toBe(200);
        const commit = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/commit`,
            headers: { cookie },
            payload: {},
        });
        expect(commit.statusCode).toBe(200);
        const history = await db.select().from(itemHistory).where(eq(itemHistory.item_id, id));
        expect(history.length).toBe(1);
    });
});

describe("peak overshoot", () => {
    test("a 60%+60% overwrite passes PEAK_FACTOR, and after the commit the quota drops without GC", async () => {
        await setUserStorage(userEmail, 1000, 0);
        const { itemId, chunkSetId } = await createSeededFileItem(app, cookie, userEmail, 700);
        expect(await getUserStorageUsed(userEmail)).toBe(700);

        const open = await openRestore([manifestItem(itemId, "file", null, 700)], "overwrite_all");
        expect(open.statusCode).toBe(201);
        expect(open.json().verdict.ok).toBe(true);
        expect(open.json().verdict.quota.peak_ok).toBe(true);
        const sessionId = open.json().restore_session_id as string;

        const upload = await app.inject({
            method: "POST",
            url: "/uploads",
            headers: { cookie },
            payload: {
                expected_chunks: 1,
                total_size: 700,
                chunk_sizes: [700],
                restore_session_id: sessionId,
            },
        });
        expect(upload.statusCode).toBe(201);
        const newCs = upload.json().chunk_set_id as string;

        const putUrls = await app.inject({
            method: "POST",
            url: `/uploads/${newCs}/urls`,
            headers: { cookie },
            payload: { indices: [0] },
        });
        expect(putUrls.statusCode).toBe(200);
        const putUrl = putUrls.json().urls[0].put_url as string;
        const put = await fetch(putUrl, { method: "PUT", body: Buffer.alloc(700, 1) });
        expect(put.ok).toBe(true);
        expect(
            (
                await app.inject({
                    method: "POST",
                    url: `/uploads/${newCs}/finalize`,
                    headers: { cookie },
                })
            ).statusCode,
        ).toBe(200);

        const stage = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/items`,
            headers: { cookie },
            payload: { items: [filePayload(itemId, newCs, { ciphertext_size: 700 })] },
        });
        expect(stage.statusCode).toBe(200);

        const peakUsed = await getUserStorageUsed(userEmail);
        expect(peakUsed).toBeGreaterThan(1000);
        expect(peakUsed).toBeLessThanOrEqual(2000);

        const commit = await app.inject({
            method: "POST",
            url: `/restore/sessions/${sessionId}/commit`,
            headers: { cookie },
            payload: {},
        });
        expect(commit.statusCode).toBe(200);
        expect(await getUserStorageUsed(userEmail)).toBe(700);
        expect(await getChunkSetPendingDeleteAt(chunkSetId)).not.toBeNull();
        expect(await countChunkSets()).toBeGreaterThanOrEqual(1);
    });
});

describe("the GC restore branch", () => {
    test("runGc leaves an open session's staging alone, but cleans up an expired one and releases the quota", async () => {
        const noteId = uuidv7();
        const usedBefore = await getUserStorageTotal(userEmail);
        const open = await openRestore([manifestItem(noteId, "note", null, 16)]);
        const sessionId = open.json().restore_session_id as string;
        expect((await stageNotes(sessionId, [notePayload(noteId)])).statusCode).toBe(200);
        const usedStaged = await getUserStorageTotal(userEmail);
        expect(usedStaged).toBeGreaterThan(usedBefore);

        const now = Math.floor(Date.now() / 1000);
        const alive = await runGc({ now, staleUploadSeconds: 0, orphanChunkSetMinAgeSeconds: 0 });
        expect(alive.restoreSessions).toBe(0);
        expect(await getUserStorageTotal(userEmail)).toBe(usedStaged);
        const [still] = await db
            .select()
            .from(restoreSessions)
            .where(eq(restoreSessions.id, sessionId));
        expect(still?.status).toBe("open");

        const expired = await runGc({
            now: now + 40 * 60,
            staleUploadSeconds: 0,
            orphanChunkSetMinAgeSeconds: 0,
        });
        expect(expired.restoreSessions).toBe(1);
        expect(await getUserStorageTotal(userEmail)).toBe(usedBefore);
        const [gone] = await db
            .select()
            .from(restoreSessions)
            .where(eq(restoreSessions.id, sessionId));
        expect(gone).toBeUndefined();
    });
});
