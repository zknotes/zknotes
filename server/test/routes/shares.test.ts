import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { items, shareLinks, users } from "../../src/db/schema";
import { runGc } from "../../src/gc";
import { hashAuthKey } from "../../src/services/auth-service";
import {
    isShareChunkAccessible,
    SHARE_BURN_DOWNLOAD_GRACE_SEC,
} from "../../src/services/share-gate";
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

async function createNote(c = cookie, overrides?: Record<string, unknown>): Promise<string> {
    const id = uuidv7();
    const res = await app.inject({
        method: "POST",
        url: "/items",
        headers: { cookie: c },
        payload: notePayload(id, overrides),
    });
    expect(res.statusCode).toBe(201);
    return id;
}

/** A fixed view_proof for the API tests (44 base64 characters) — it has to be the same on create and on view. */
const TEST_VIEW_PROOF = "A".repeat(44);

function shareCreatePayload(
    shareId: string,
    sourceItemId: string,
    overrides?: Record<string, unknown>,
) {
    return {
        id: shareId,
        source_item_id: sourceItemId,
        wrapped_item_key: "A".repeat(64),
        item_key_nonce: "A".repeat(32),
        expires_in_sec: null,
        max_views: null,
        view_proof: TEST_VIEW_PROOF,
        share_auth_key: null,
        share_kdf_salt: null,
        share_kdf_params: null,
        ...overrides,
    };
}

function viewPayload(overrides?: Record<string, unknown>) {
    return { view_proof: TEST_VIEW_PROOF, ...overrides };
}

/**
 * The body a real recipient sends to the chunk route. The view proof is derived from the `#k=`
 * fragment key, so holding it is what separates the person the link was sent to from anyone who
 * merely saw its address.
 */
function chunkBody(overrides?: Record<string, string>): Record<string, string> {
    return { view_proof: TEST_VIEW_PROOF, ...overrides };
}

async function postShare(payload: Record<string, unknown>, c = cookie) {
    return app.inject({
        method: "POST",
        url: "/shares",
        headers: { cookie: c },
        payload,
    });
}

/**
 * Open-core has no plans: the permissive provider (seam 2) returns `isPaid: true` for everyone, so
 * "give them a paid plan" is a no-op. The function stays so the tests need not change.
 */
async function grantPaidPlan(_email = "test@example.com") {
    // deliberately empty — see the comment above
}

async function createNoteFile(noteId: string, c = cookie): Promise<string> {
    const userId = (await getUserIdByEmail("test@example.com"))!;
    const chunkSetId = uuidv7();
    const fileId = uuidv7();
    await insertChunkSet(chunkSetId, userId, { totalSize: 100 });
    const res = await app.inject({
        method: "POST",
        url: "/items",
        headers: { cookie: c },
        payload: filePayload(fileId, chunkSetId, { parent_id: noteId }),
    });
    expect(res.statusCode).toBe(201);
    return fileId;
}

describe("POST /shares", () => {
    test("create → 201; idempotent re-POST → 200", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        const payload = shareCreatePayload(shareId, noteId);

        const first = await postShare(payload);
        expect(first.statusCode).toBe(201);

        const second = await postShare(payload);
        expect(second.statusCode).toBe(200);
        expect(second.json().id).toBe(shareId);
    });

    test("second active link for same note → 409; after revoke → ok", async () => {
        const noteId = await createNote();
        const a = await postShare(shareCreatePayload(uuidv7(), noteId));
        expect(a.statusCode).toBe(201);

        const b = await postShare(shareCreatePayload(uuidv7(), noteId));
        expect(b.statusCode).toBe(409);

        const shareId = a.json().id as string;
        const del = await app.inject({
            method: "DELETE",
            url: `/shares/${shareId}`,
            headers: { cookie },
        });
        expect(del.statusCode).toBe(200);

        const c = await postShare(shareCreatePayload(uuidv7(), noteId));
        expect(c.statusCode).toBe(201);
    });

    // The weak_kdf_params floor is skipped under NODE_ENV=test (assertKdfParamsFloor) — see cryptography.test.ts
});

describe("GET /shares/:id metadata", () => {
    test("unavailable cases return identical body", async () => {
        const missing = await app.inject({ method: "GET", url: `/shares/${uuidv7()}` });
        expect(missing.statusCode).toBe(200);
        expect(missing.json() as { status: string }).toEqual({ status: "unavailable" });

        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(shareCreatePayload(shareId, noteId));
        await app.inject({
            method: "DELETE",
            url: `/shares/${shareId}`,
            headers: { cookie },
        });
        const revoked = await app.inject({ method: "GET", url: `/shares/${shareId}` });
        expect(revoked.json() as { status: string }).toEqual({ status: "unavailable" });
        expect(revoked.body).toBe(missing.body);
    });

    test("live share returns metadata without ciphertext", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(shareCreatePayload(shareId, noteId));

        const meta = await app.inject({ method: "GET", url: `/shares/${shareId}` });
        expect(meta.statusCode).toBe(200);
        const body = meta.json();
        expect(body.needs_password).toBe(false);
        expect(body.encrypted_payload).toBeUndefined();
    });

    // Regression: mode:"meta" in verifyShareGate demanded a share_auth_key as
    // soon as share_auth_key_hash was set — but the meta route never sends one (the whole point of a
    // meta call is to tell the client a password is needed, BEFORE the client has it). The result:
    // EVERY password-protected share returned unavailable on the metadata alone, and a guest never
    // saw the password field (caught by E2E: 18-share-link.spec.ts "password-protected link").
    test("password-protected share still returns needs_password metadata (no key required for meta)", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(
            shareCreatePayload(shareId, noteId, {
                share_auth_key: "A".repeat(44),
                share_kdf_salt: "B".repeat(24),
                share_kdf_params: { m: 1024, t: 1, p: 1 },
            }),
        );

        const meta = await app.inject({ method: "GET", url: `/shares/${shareId}` });
        expect(meta.statusCode).toBe(200);
        const body = meta.json();
        expect(body).not.toEqual({ status: "unavailable" });
        expect(body.needs_password).toBe(true);
    });

    test("GET /shares/:id returns unavailable (not 500) for a non-UUID id", async () => {
        const res = await app.inject({ method: "GET", url: "/shares/not-a-uuid" });
        expect(res.statusCode).toBe(200);
        expect(res.json() as { status: string }).toEqual({ status: "unavailable" });
    });

    test("GET /shares/:id sets Cache-Control: no-store on live and unavailable responses", async () => {
        const missing = await app.inject({ method: "GET", url: `/shares/${uuidv7()}` });
        expect(missing.headers["cache-control"]).toBe("no-store");

        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(shareCreatePayload(shareId, noteId));
        const live = await app.inject({ method: "GET", url: `/shares/${shareId}` });
        expect(live.statusCode).toBe(200);
        expect(live.json()).not.toEqual({ status: "unavailable" });
        expect(live.headers["cache-control"]).toBe("no-store");
    });
});

describe("POST /shares/:id/view", () => {
    test("view without link-key proof does not burn a one-time share", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        const created = await postShare(shareCreatePayload(shareId, noteId, { max_views: 1 }));
        expect(created.statusCode).toBe(201);

        // Without a view_proof — it must not burn the single-use link.
        const bare = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: {},
        });
        expect(bare.statusCode).toBe(200);
        expect(bare.json() as { status: string }).toEqual({ status: "unavailable" });

        const [afterBare] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(afterBare?.view_count).toBe(0);
        expect(afterBare?.revoked_at).toBeNull();

        // With the correct proof — burn.
        const ok = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.json().encrypted_payload).toBeTruthy();

        const [afterOk] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(afterOk?.view_count).toBe(1);
        expect(afterOk?.revoked_at).not.toBeNull();
    });

    test("returns current item blob; burn blocks second view", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(shareCreatePayload(shareId, noteId, { max_views: 1 }));

        const first = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect(first.statusCode).toBe(200);
        expect(first.json().encrypted_payload).toBe("cGF5bG9hZA==");

        const second = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect(second.json() as { status: string }).toEqual({ status: "unavailable" });

        const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(row?.revoked_at).not.toBeNull();
    });

    test("concurrent views of a one-time share burn exactly once", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(shareCreatePayload(shareId, noteId, { max_views: 1 }));

        const results = await Promise.all(
            [0, 1, 2].map(() =>
                app.inject({
                    method: "POST",
                    url: `/shares/${shareId}/view`,
                    payload: viewPayload(),
                }),
            ),
        );

        const successes = results.filter((r) => r.json().encrypted_payload);
        const unavail = results.filter(
            (r) => (r.json() as { status?: string }).status === "unavailable",
        );
        expect(successes).toHaveLength(1);
        expect(unavail).toHaveLength(2);

        const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(row?.view_count).toBe(1);
        expect(row?.revoked_at).not.toBeNull();
    });

    test("POST /shares/:id/view sets Cache-Control: no-store on live and unavailable responses", async () => {
        const missing = await app.inject({
            method: "POST",
            url: `/shares/${uuidv7()}/view`,
            payload: viewPayload(),
        });
        expect(missing.json() as { status: string }).toEqual({ status: "unavailable" });
        expect(missing.headers["cache-control"]).toBe("no-store");

        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(shareCreatePayload(shareId, noteId));
        const live = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect(live.statusCode).toBe(200);
        expect(live.json().encrypted_payload).toBeTruthy();
        expect(live.headers["cache-control"]).toBe("no-store");
    });

    test("live edit updates view payload", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(shareCreatePayload(shareId, noteId));

        await app.inject({
            method: "PUT",
            url: `/items/${noteId}`,
            headers: { cookie },
            payload: notePayload(noteId, {
                encrypted_payload: "bmV3cGF5bG9hZA==",
                version: 1,
            }),
        });

        const view = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect(view.json().encrypted_payload).toBe("bmV3cGF5bG9hZA==");
    });

    test("trashed source → unavailable", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(shareCreatePayload(shareId, noteId));

        await db
            .update(items)
            .set({ deleted_at: Math.floor(Date.now() / 1000) })
            .where(eq(items.id, noteId));

        const meta = await app.inject({ method: "GET", url: `/shares/${shareId}` });
        const view = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect(meta.json() as { status: string }).toEqual({ status: "unavailable" });
        expect(view.json() as { status: string }).toEqual({ status: "unavailable" });
    });

    test("password: wrong and missing key → same unavailable", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        const authKey = "A".repeat(44);
        const hash = await hashAuthKey(authKey);
        await postShare(
            shareCreatePayload(shareId, noteId, {
                share_auth_key: authKey,
                share_kdf_salt: "B".repeat(24),
                share_kdf_params: { m: 1024, t: 1, p: 1 },
            }),
        );

        const missing = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        const wrong = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload({ share_auth_key: "B".repeat(44) }),
        });
        expect(missing.json() as { status: string }).toEqual({ status: "unavailable" });
        expect(wrong.json() as { status: string }).toEqual({ status: "unavailable" });

        const ok = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload({ share_auth_key: authKey }),
        });
        expect(ok.json().encrypted_payload).toBe("cGF5bG9hZA==");
        expect(await verify(hash, authKey)).toBe(true);
    });

    test("repeated wrong share passwords lock the share", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        const authKey = "C".repeat(44);
        await postShare(
            shareCreatePayload(shareId, noteId, {
                share_auth_key: authKey,
                share_kdf_salt: "D".repeat(24),
                share_kdf_params: { m: 1024, t: 1, p: 1 },
            }),
        );

        // The default SHARE_PASSWORD_MAX_ATTEMPTS = 5 — five wrong attempts, then a lock.
        for (let i = 0; i < 5; i++) {
            const res = await app.inject({
                method: "POST",
                url: `/shares/${shareId}/view`,
                payload: viewPayload({ share_auth_key: "Z".repeat(44) }),
            });
            expect(res.json() as { status: string }).toEqual({ status: "unavailable" });
        }

        const [locked] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(locked?.failed_attempts).toBeGreaterThanOrEqual(5);
        expect(locked?.locked_until).not.toBeNull();
        expect((locked?.locked_until ?? 0) > Math.floor(Date.now() / 1000)).toBe(true);

        // The correct key is still unavailable while the lock holds.
        const whileLocked = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload({ share_auth_key: authKey }),
        });
        expect(whileLocked.json() as { status: string }).toEqual({ status: "unavailable" });

        // Unlock into the past — the correct key passes.
        await db
            .update(shareLinks)
            .set({ locked_until: Math.floor(Date.now() / 1000) - 10 })
            .where(eq(shareLinks.id, shareId));
        const after = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload({ share_auth_key: authKey }),
        });
        expect(after.statusCode).toBe(200);
        expect(after.json().encrypted_payload).toBeTruthy();
        const [reset] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(reset?.failed_attempts).toBe(0);
        expect(reset?.locked_until).toBeNull();
        expect(reset?.failed_window_started_at).toBeNull();
    });

    test("wrong share passwords inside the window increment the counter", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(
            shareCreatePayload(shareId, noteId, {
                share_auth_key: "C".repeat(44),
                share_kdf_salt: "D".repeat(24),
                share_kdf_params: { m: 1024, t: 1, p: 1 },
            }),
        );

        const miss = async () =>
            app.inject({
                method: "POST",
                url: `/shares/${shareId}/view`,
                payload: viewPayload({ share_auth_key: "Z".repeat(44) }),
            });

        expect((await miss()).json() as { status: string }).toEqual({ status: "unavailable" });
        const [first] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(first?.failed_attempts).toBe(1);
        expect(first?.failed_window_started_at).not.toBeNull();
        const windowStart = first?.failed_window_started_at ?? 0;

        expect((await miss()).json() as { status: string }).toEqual({ status: "unavailable" });
        const [second] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(second?.failed_attempts).toBe(2);
        expect(second?.failed_window_started_at).toBe(windowStart);
    });

    test("a wrong share password after the window has lapsed restarts the count at 1", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        await postShare(
            shareCreatePayload(shareId, noteId, {
                share_auth_key: "C".repeat(44),
                share_kdf_salt: "D".repeat(24),
                share_kdf_params: { m: 1024, t: 1, p: 1 },
            }),
        );

        const now = Math.floor(Date.now() / 1000);
        const longAgo = now - 4000;
        await db
            .update(shareLinks)
            .set({
                failed_attempts: 9,
                locked_until: now - 10,
                failed_window_started_at: longAgo,
            })
            .where(eq(shareLinks.id, shareId));

        const miss = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload({ share_auth_key: "Z".repeat(44) }),
        });
        expect(miss.json() as { status: string }).toEqual({ status: "unavailable" });

        const [after] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(after?.failed_attempts).toBe(1);
        expect(after?.locked_until).toBeNull();
        expect(after?.failed_window_started_at ?? 0).toBeGreaterThan(longAgo);
    });

    // A share created before `view_proof` existed has no stored hash. The runtime gate must not open
    // it on the share id (or even on a guessed proof) — otherwise anyone holding the UUID could fetch
    // the ciphertext.
    test("a share with no view_proof_hash is unavailable even with the password", async () => {
        const noteId = await createNote();
        const fileId = await createNoteFile(noteId);
        const shareId = uuidv7();
        const authKey = "C".repeat(44);
        expect(
            (
                await postShare(
                    shareCreatePayload(shareId, noteId, {
                        share_auth_key: authKey,
                        share_kdf_salt: "D".repeat(24),
                        share_kdf_params: { m: 1024, t: 1, p: 1 },
                        attachments: [
                            {
                                file_id: fileId,
                                wrapped_item_key: "A".repeat(64),
                                item_key_nonce: "A".repeat(32),
                            },
                        ],
                    }),
                )
            ).statusCode,
        ).toBe(201);

        await db
            .update(shareLinks)
            .set({ view_proof_hash: null })
            .where(eq(shareLinks.id, shareId));

        const meta = await app.inject({ method: "GET", url: `/shares/${shareId}` });
        const view = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload({ share_auth_key: authKey }),
        });
        const chunk = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/chunks/${fileId}/0`,
            payload: chunkBody({ share_auth_key: authKey }),
        });
        expect(meta.json() as { status: string }).toEqual({ status: "unavailable" });
        expect(view.json() as { status: string }).toEqual({ status: "unavailable" });
        expect(chunk.json() as { status: string }).toEqual({ status: "unavailable" });

        const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(row?.failed_attempts ?? 0).toBe(0);
        expect(row?.locked_until ?? null).toBeNull();
    });

    test("parallel wrong share passwords on the chunk route increment atomically", async () => {
        const noteId = await createNote();
        const fileId = await createNoteFile(noteId);
        const shareId = uuidv7();
        await postShare(
            shareCreatePayload(shareId, noteId, {
                share_auth_key: "C".repeat(44),
                share_kdf_salt: "D".repeat(24),
                share_kdf_params: { m: 1024, t: 1, p: 1 },
                attachments: [
                    {
                        file_id: fileId,
                        wrapped_item_key: "A".repeat(64),
                        item_key_nonce: "A".repeat(32),
                    },
                ],
            }),
        );

        const n = 4;
        await Promise.all(
            Array.from({ length: n }, () =>
                app.inject({
                    method: "POST",
                    url: `/shares/${shareId}/chunks/${fileId}/0`,
                    payload: chunkBody({ share_auth_key: "Z".repeat(44) }),
                }),
            ),
        );

        const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(row?.failed_attempts).toBe(n);
    });

    test("shares of an admin-locked account are unavailable on meta, view and chunk", async () => {
        const noteId = await createNote();
        const fileId = await createNoteFile(noteId);
        const shareId = uuidv7();
        expect(
            (
                await postShare(
                    shareCreatePayload(shareId, noteId, {
                        attachments: [
                            {
                                file_id: fileId,
                                wrapped_item_key: "A".repeat(64),
                                item_key_nonce: "A".repeat(32),
                            },
                        ],
                    }),
                )
            ).statusCode,
        ).toBe(201);

        const userId = (await getUserIdByEmail("test@example.com"))!;
        await db
            .update(users)
            .set({ locked_at: Math.floor(Date.now() / 1000) })
            .where(eq(users.id, userId));

        const meta = await app.inject({ method: "GET", url: `/shares/${shareId}` });
        const view = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        const chunk = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/chunks/${fileId}/0`,
            payload: chunkBody(),
        });
        expect(meta.json() as { status: string }).toEqual({ status: "unavailable" });
        expect(view.json() as { status: string }).toEqual({ status: "unavailable" });
        expect(chunk.json() as { status: string }).toEqual({ status: "unavailable" });
    });

    test("the chunk route rejects a caller with no view_proof, and never locks the share", async () => {
        // The chunk route used to take a password with no proof of the fragment key, so anyone who
        // merely knew the share id — it travels in the URL path, unlike the `#k=` fragment — could
        // lock the link out from under its real recipient with five requests, escalating to a
        // fifteen-minute lock held indefinitely by one request a quarter of an hour.
        const noteId = await createNote();
        const fileId = await createNoteFile(noteId);
        const shareId = uuidv7();
        const authKey = "C".repeat(44);
        const created = await postShare(
            shareCreatePayload(shareId, noteId, {
                share_auth_key: authKey,
                share_kdf_salt: "D".repeat(24),
                share_kdf_params: { m: 1024, t: 1, p: 1 },
                attachments: [
                    {
                        file_id: fileId,
                        wrapped_item_key: "A".repeat(64),
                        item_key_nonce: "A".repeat(32),
                    },
                ],
            }),
        );
        expect(created.statusCode).toBe(201);

        // An outsider holding only the share id hammers the chunk route with wrong verifiers and
        // no view_proof. Each one is refused before it can reach the password check.
        for (let i = 0; i < 8; i++) {
            const res = await app.inject({
                method: "POST",
                url: `/shares/${shareId}/chunks/${fileId}/0`,
                payload: { share_auth_key: "Z".repeat(44) },
            });
            expect(res.json() as { status: string }).toEqual({ status: "unavailable" });
        }

        // A wrong view_proof is refused the same way — a guess at the fragment key is not an
        // attempt at the password either.
        for (let i = 0; i < 8; i++) {
            const res = await app.inject({
                method: "POST",
                url: `/shares/${shareId}/chunks/${fileId}/0`,
                payload: {
                    share_auth_key: "Z".repeat(44),
                    view_proof: "Y".repeat(44),
                },
            });
            expect(res.json() as { status: string }).toEqual({ status: "unavailable" });
        }

        const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(row?.failed_attempts ?? 0).toBe(0);
        expect(row?.locked_until ?? null).toBeNull();

        // The real recipient, with the correct password, is unaffected.
        const view = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload({ share_auth_key: authKey }),
        });
        expect(view.statusCode).toBe(200);
        expect(view.json().encrypted_payload).toBeTruthy();
    });
});

describe("share attachments", () => {
    test("free user: create with attachment → view returns attachments", async () => {
        const noteId = await createNote();
        const fileId = await createNoteFile(noteId);
        const shareId = uuidv7();
        const create = await postShare(
            shareCreatePayload(shareId, noteId, {
                attachments: [
                    {
                        file_id: fileId,
                        wrapped_item_key: "F".repeat(64),
                        item_key_nonce: "F".repeat(32),
                    },
                ],
            }),
        );
        expect(create.statusCode).toBe(201);

        const meta = await app.inject({ method: "GET", url: `/shares/${shareId}` });
        expect(meta.json().has_attachments).toBe(true);

        const view = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect(view.statusCode).toBe(200);
        const body = view.json();
        expect(body.attachments).toHaveLength(1);
        expect(body.attachments[0].file_id).toBe(fileId);
        expect(body.attachments[0].chunk_set_id).toBeDefined();
    });

    test("paid user: create with attachment → view returns attachments", async () => {
        await grantPaidPlan();
        const noteId = await createNote();
        const fileId = await createNoteFile(noteId);
        const shareId = uuidv7();
        const create = await postShare(
            shareCreatePayload(shareId, noteId, {
                attachments: [
                    {
                        file_id: fileId,
                        wrapped_item_key: "F".repeat(64),
                        item_key_nonce: "F".repeat(32),
                    },
                ],
            }),
        );
        expect(create.statusCode).toBe(201);

        const meta = await app.inject({ method: "GET", url: `/shares/${shareId}` });
        expect(meta.json().has_attachments).toBe(true);

        const view = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect(view.statusCode).toBe(200);
        const body = view.json();
        expect(body.attachments).toHaveLength(1);
        expect(body.attachments[0].file_id).toBe(fileId);
        expect(body.attachments[0].chunk_set_id).toBeDefined();
    });

    test("invalid attachment (wrong parent) → 400", async () => {
        await grantPaidPlan();
        const noteId = await createNote();
        const otherNote = await createNote();
        const fileId = await createNoteFile(otherNote);
        const res = await postShare(
            shareCreatePayload(uuidv7(), noteId, {
                attachments: [
                    {
                        file_id: fileId,
                        wrapped_item_key: "F".repeat(64),
                        item_key_nonce: "F".repeat(32),
                    },
                ],
            }),
        );
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("invalid_attachment");
    });

    test("chunk endpoint: invalid index → 400; after view returns presigned url", async () => {
        await grantPaidPlan();
        const noteId = await createNote();
        const fileId = await createNoteFile(noteId);
        const shareId = uuidv7();
        await postShare(
            shareCreatePayload(shareId, noteId, {
                attachments: [
                    {
                        file_id: fileId,
                        wrapped_item_key: "F".repeat(64),
                        item_key_nonce: "F".repeat(32),
                    },
                ],
            }),
        );

        const bad = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/chunks/${fileId}/not-a-number`,
            payload: chunkBody(),
        });
        expect(bad.statusCode).toBe(400);

        await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });

        const chunk = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/chunks/${fileId}/0`,
            payload: chunkBody(),
        });
        expect(chunk.statusCode).toBe(200);
        expect(chunk.json().url).toMatch(/^https?:\/\//);

        // ...and the same request without the fragment-key proof gets nothing.
        const noProof = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/chunks/${fileId}/0`,
            payload: {},
        });
        expect(noProof.json() as { status: string }).toEqual({ status: "unavailable" });

        // The verifiers used to travel in headers, which proxies write to their access logs. The
        // GET route that read them is gone.
        const viaHeaders = await app.inject({
            method: "GET",
            url: `/shares/${shareId}/chunks/${fileId}/0`,
            headers: { "x-share-view-proof": TEST_VIEW_PROOF },
        });
        expect(viaHeaders.statusCode).toBe(404);
    });
});

describe("burn download grace (chunk gate)", () => {
    async function createBurnShareWithFile(): Promise<{ shareId: string; fileId: string }> {
        await grantPaidPlan();
        const noteId = await createNote();
        const fileId = await createNoteFile(noteId);
        const shareId = uuidv7();
        const res = await postShare(
            shareCreatePayload(shareId, noteId, {
                max_views: 1,
                attachments: [
                    {
                        file_id: fileId,
                        wrapped_item_key: "F".repeat(64),
                        item_key_nonce: "F".repeat(32),
                    },
                ],
            }),
        );
        expect(res.statusCode).toBe(201);
        return { shareId, fileId };
    }

    async function getChunk(shareId: string, fileId: string) {
        return app.inject({
            method: "POST",
            url: `/shares/${shareId}/chunks/${fileId}/0`,
            payload: chunkBody(),
        });
    }

    test("burned link: chunks accessible within grace, dead after grace expires", async () => {
        const { shareId, fileId } = await createBurnShareWithFile();

        await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });

        const within = await getChunk(shareId, fileId);
        expect(within.json().url).toBeDefined();

        // Simulate the grace window elapsing: move its deadline into the past.
        const past = Math.floor(Date.now() / 1000) - 5;
        await db
            .update(shareLinks)
            .set({ burn_grace_until: past })
            .where(eq(shareLinks.id, shareId));

        const after = await getChunk(shareId, fileId);
        expect(after.json().status).toBe("unavailable");
    });

    test("owner revoke before view closes chunks (no grace)", async () => {
        const { shareId, fileId } = await createBurnShareWithFile();

        const revoke = await app.inject({
            method: "DELETE",
            url: `/shares/${shareId}`,
            headers: { cookie },
        });
        expect(revoke.statusCode).toBe(200);

        const chunk = await getChunk(shareId, fileId);
        expect(chunk.json().status).toBe("unavailable");
    });

    // Regression: the grace window used to be inferred from `revoked_at === last_viewed_at`, which
    // a burn writes in one UPDATE. DELETE /shares/:id writes COALESCE(revoked_at, now), so revoking
    // an ALREADY-burned link preserved the burn timestamp, the equality still held, and attachments
    // kept flowing for the rest of the fifteen-minute window — while Revoke is the only thing an
    // owner can do once a link has reached the wrong person.
    test("owner revoke AFTER the burn closes the grace window immediately", async () => {
        const { shareId, fileId } = await createBurnShareWithFile();

        await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });

        // The grace window is open: the recipient can still finish their download.
        expect((await getChunk(shareId, fileId)).json().url).toBeDefined();

        const revoke = await app.inject({
            method: "DELETE",
            url: `/shares/${shareId}`,
            headers: { cookie },
        });
        expect(revoke.statusCode).toBe(200);

        expect((await getChunk(shareId, fileId)).json().status).toBe("unavailable");

        const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(row?.burn_grace_until).toBeNull();
        // ...and the burn's own revoked_at is still the one COALESCE preserved, so this is the exact
        // state the old inference mistook for "still burning".
        expect(row?.revoked_at).toBe(row?.last_viewed_at ?? -1);
    });

    test("burned link does not serve chunks after expires_at even during grace", async () => {
        const { shareId, fileId } = await createBurnShareWithFile();

        await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect((await getChunk(shareId, fileId)).json().url).toBeDefined();

        const now = Math.floor(Date.now() / 1000);
        await db
            .update(shareLinks)
            .set({
                expires_at: now - 1,
                burn_grace_until: now + SHARE_BURN_DOWNLOAD_GRACE_SEC,
            })
            .where(eq(shareLinks.id, shareId));

        const chunk = await getChunk(shareId, fileId);
        expect(chunk.json().status).toBe("unavailable");
    });

    test("expired one-time link swept by GC does not re-open chunk access", async () => {
        const { shareId, fileId } = await createBurnShareWithFile();
        const now = Math.floor(Date.now() / 1000);

        // The link was viewed in the past and then expired. Only a real burn through the view route
        // opens a grace window (it is the sole writer of burn_grace_until), and the GC sweep clears
        // the column anyway — an expired link serves nothing.
        await db
            .update(shareLinks)
            .set({ view_count: 1, last_viewed_at: now - 3600, expires_at: now - 60 })
            .where(eq(shareLinks.id, shareId));
        await runGc({ now });

        const chunk = await getChunk(shareId, fileId);
        expect(chunk.json().status).toBe("unavailable");
    });

    test("view response carries burn_download_grace_sec only on burn", async () => {
        const { shareId } = await createBurnShareWithFile();
        const view = await app.inject({
            method: "POST",
            url: `/shares/${shareId}/view`,
            payload: viewPayload(),
        });
        expect(view.json().burn_download_grace_sec).toBe(SHARE_BURN_DOWNLOAD_GRACE_SEC);

        const noteId = await createNote();
        const standardId = uuidv7();
        await postShare(shareCreatePayload(standardId, noteId));
        const view2 = await app.inject({
            method: "POST",
            url: `/shares/${standardId}/view`,
            payload: viewPayload(),
        });
        expect(view2.json().burn_download_grace_sec).toBeUndefined();
    });
});

describe("isShareChunkAccessible", () => {
    const now = 10_000;
    const row = (overrides: {
        revoked_at?: number | null;
        expires_at?: number | null;
        burn_grace_until?: number | null;
    }) =>
        ({
            revoked_at: null,
            expires_at: null,
            burn_grace_until: null,
            ...overrides,
        }) as Parameters<typeof isShareChunkAccessible>[0];

    test("an active unexpired share is accessible", () => {
        expect(isShareChunkAccessible(row({}), now)).toBe(true);
    });

    test("refuses an expired share even inside burn grace", () => {
        expect(
            isShareChunkAccessible(
                row({ revoked_at: 9_000, expires_at: 8_000, burn_grace_until: 20_000 }),
                now,
            ),
        ).toBe(false);
    });

    test("a burned unexpired share stays accessible until burn_grace_until", () => {
        expect(
            isShareChunkAccessible(
                row({ revoked_at: 9_000, expires_at: 20_000, burn_grace_until: 20_000 }),
                now,
            ),
        ).toBe(true);
        expect(
            isShareChunkAccessible(
                row({ revoked_at: 9_000, expires_at: null, burn_grace_until: 9_999 }),
                now,
            ),
        ).toBe(false);
    });
});

describe("share GC", () => {
    test("expired shares revoked; old rows deleted after retention", async () => {
        const noteId = await createNote();
        const shareId = uuidv7();
        const now = Math.floor(Date.now() / 1000);
        await db.insert(shareLinks).values({
            id: shareId,
            user_id: (await getUserIdByEmail("test@example.com"))!,
            source_item_id: noteId,
            wrapped_item_key: Buffer.from("key"),
            item_key_nonce: Buffer.alloc(24),
            expires_at: now - 60,
            view_count: 0,
            created_at: now - 100 * 24 * 3600,
            updated_at: now - 100 * 24 * 3600,
        });

        const gc = await runGc({ now, shareRowRetentionSeconds: 200 * 24 * 3600 });
        expect(gc.shareLinksExpired).toBe(1);

        const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(row?.revoked_at).not.toBeNull();

        const gc2 = await runGc({ now, shareRowRetentionSeconds: 30 * 24 * 3600 });
        expect(gc2.shareLinksDeleted).toBe(1);
        const remaining = await db.select().from(shareLinks).where(eq(shareLinks.id, shareId));
        expect(remaining.length).toBe(0);
    });
});
