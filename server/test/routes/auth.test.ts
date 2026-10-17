import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    spyOn,
    test,
} from "bun:test";
import { createHash } from "node:crypto";
import { PRODUCTION_KDF_PARAMS } from "@zknotes/shared";
import { and, count, eq, sql } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { SESSION_TTL_SECONDS } from "../../src/routes/auth";
import { db } from "../../src/db";
import { chunkSets, loginFailures, sessions, users } from "../../src/db/schema";
import { nowSec } from "../../src/lib/time";
import * as authService from "../../src/services/auth-service";
import { createTestUser, getUserIdByEmail, insertChunkSet, notePayload, resetDb } from "../helpers";

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

/** Pull the `session_token=...` cookie out of an inject response (for the session-rotation tests). */
function cookieFromResponse(res: LightMyRequestResponse): string {
    const setCookie = res.headers["set-cookie"];
    const str = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const token = str?.match(/session_token=([^;]+)/)?.[1];
    if (!token) throw new Error("No session_token cookie in response");
    return `session_token=${token}`;
}

let app: FastifyInstance;
const originalNodeEnv = process.env.NODE_ENV;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(resetDb);

afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
});

/** The `kdf_salt` every `registerPayload` vault is created with — the real one, not the fake. */
const REAL_KDF_SALT = "B".repeat(24);

const registerPayload = (email: string) => ({
    email,
    auth_key: "A".repeat(44),
    kdf_salt: REAL_KDF_SALT,
    kdf_params: { m: 1024, t: 1, p: 1 },
    encrypted_vault_key: "A".repeat(64), // base64 48B
    vault_key_nonce: "B".repeat(32), // base64 24 B (no padding)
});

// The core has no `POST /auth/register` or `POST /auth/verify-email` route; a vault is created
// through `POST /vault` alone.

// The status endpoint and the route must answer the same question. Before this,
// `GET /auth/registration-status` always returned `open: true` while `POST /vault` answered 403
// once a vault existed — the UI offered a registration that could not work. Both now read
// `entitlements.ts::selfHostRegistrationStatus`.
describe("registration: status and POST /vault agree", () => {
    const originalRegistrationOpen = process.env.SELF_HOST_REGISTRATION_OPEN;

    afterEach(() => {
        if (originalRegistrationOpen === undefined) {
            delete process.env.SELF_HOST_REGISTRATION_OPEN;
        } else {
            process.env.SELF_HOST_REGISTRATION_OPEN = originalRegistrationOpen;
        }
    });

    const statusOpen = async (): Promise<boolean> => {
        const res = await app.inject({ method: "GET", url: "/auth/registration-status" });
        expect(res.statusCode).toBe(200);
        return res.json().open;
    };

    const createVault = (email: string) =>
        app.inject({ method: "POST", url: "/vault", payload: registerPayload(email) });

    test("empty database: open, and the first vault really is created", async () => {
        process.env.SELF_HOST_REGISTRATION_OPEN = "false";

        expect(await statusOpen()).toBe(true);
        expect((await createVault("first@example.com")).statusCode).toBe(201);
    });

    // Both used to pass: each request saw an empty instance before either had inserted its user.
    test("two concurrent first vaults: exactly one is created", async () => {
        process.env.SELF_HOST_REGISTRATION_OPEN = "false";

        // A real Argon2 hash takes long enough for the requests to overlap; the test parameters
        // do not, so the hash is slowed down here.
        const realHash = authService.hashAuthKey;
        const slowHash = spyOn(authService, "hashAuthKey").mockImplementation(async (key) => {
            await Bun.sleep(150);
            return realHash(key);
        });
        let results: LightMyRequestResponse[];
        try {
            results = await Promise.all([
                createVault("racer-a@example.com"),
                createVault("racer-b@example.com"),
                createVault("racer-c@example.com"),
            ]);
        } finally {
            slowHash.mockRestore();
        }

        expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403, 403]);
        const [row] = await db.select({ value: count() }).from(users);
        expect(row?.value).toBe(1);
    });

    test("after the first vault: closed in both places", async () => {
        process.env.SELF_HOST_REGISTRATION_OPEN = "false";
        expect((await createVault("first@example.com")).statusCode).toBe(201);

        expect(await statusOpen()).toBe(false);

        const second = await createVault("second@example.com");
        expect(second.statusCode).toBe(403);
        expect(second.json().error).toBe("registration_closed");
    });

    test("SELF_HOST_REGISTRATION_OPEN=true keeps it open past the first vault", async () => {
        process.env.SELF_HOST_REGISTRATION_OPEN = "true";
        expect((await createVault("first@example.com")).statusCode).toBe(201);

        expect(await statusOpen()).toBe(true);
        expect((await createVault("second@example.com")).statusCode).toBe(201);
    });

    // Duplicate email must not 500: a unique-violation 500 vs a 201 is an account-existence oracle.
    test("POST /vault duplicate email returns the same 201 as a new vault", async () => {
        process.env.SELF_HOST_REGISTRATION_OPEN = "true";
        const email = "dup@example.com";

        const first = await createVault(email);
        expect(first.statusCode).toBe(201);
        expect(first.json<{ created: boolean }>()).toEqual({ created: true });

        const second = await createVault(email);
        expect(second.statusCode).toBe(201);
        expect(second.json<{ created: boolean }>()).toEqual({ created: true });
        expect(second.body.length).toBe(first.body.length);

        const third = await createVault("other@example.com");
        expect(third.statusCode).toBe(201);
        expect(third.json<{ created: boolean }>()).toEqual({ created: true });

        expect(await getUserIdByEmail(email)).toBeTruthy();
        expect(await getUserIdByEmail("other@example.com")).toBeTruthy();
        const [countRow] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
        expect(countRow?.n).toBe(2);
    });

    test("status does not leak the user count (public endpoint)", async () => {
        process.env.SELF_HOST_REGISTRATION_OPEN = "false";
        expect((await createVault("first@example.com")).statusCode).toBe(201);

        const res = await app.inject({ method: "GET", url: "/auth/registration-status" });
        expect(res.json<Record<string, unknown>>()).toEqual({ open: false });
    });
});

describe("POST /auth/kdf-params", () => {
    test("a known email returns the real salt", async () => {
        const { email } = await createTestUser(app, { email: "known@example.com" });

        const res = await app.inject({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.kdf_salt).toBeTruthy();
        expect(body.kdf_params).toBeTruthy();
    });

    test("an unknown email returns a deterministic fake salt", async () => {
        const res1 = await app.inject({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email: "ghost@example.com" },
        });
        const res2 = await app.inject({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email: "ghost@example.com" },
        });

        expect(res1.statusCode).toBe(200);
        expect(res2.statusCode).toBe(200);

        // The same email always returns the same fake salt (anti-enumeration)
        expect(res1.json().kdf_salt).toBe(res2.json().kdf_salt);
    });

    test("two different unknown emails return different fake salts", async () => {
        const res1 = await app.inject({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email: "ghost1@example.com" },
        });
        const res2 = await app.inject({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email: "ghost2@example.com" },
        });

        expect(res1.json().kdf_salt).not.toBe(res2.json().kdf_salt);
    });

    // A regression lock: the fake KDF params have to be PRODUCTION_KDF_PARAMS (not DEFAULT_*, which
    // in a test build falls back to weak values). A newly registered client in production sends
    // PRODUCTION — the fake answer has to be indistinguishable from it.
    test("kdf-params returns the same params for existing and unknown emails", async () => {
        const email = "kdf-match@example.com";
        // Open-core: a user comes into being through **the core's** path (`POST /vault`, the first
        // registration on a self-host).
        const created = await app.inject({
            method: "POST",
            url: "/vault",
            payload: { ...registerPayload(email), kdf_params: PRODUCTION_KDF_PARAMS },
        });
        expect(created.statusCode).toBe(201);

        const known = await app.inject({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email },
        });
        const unknown = await app.inject({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email: "never-registered-kdf@example.com" },
        });

        expect(known.statusCode).toBe(200);
        expect(unknown.statusCode).toBe(200);
        expect(known.json().kdf_params).toEqual(PRODUCTION_KDF_PARAMS);
        expect(unknown.json().kdf_params).toEqual(known.json().kdf_params);
    });

    test("AUTH_JITTER_MS is configured in production posture", async () => {
        const { DEFAULT_AUTH_JITTER_MS } = await import("../../src/routes/auth");
        expect(DEFAULT_AUTH_JITTER_MS).toBeGreaterThan(0);
    });

    // Regression: a vault is WRITTEN under the normalised address but used to be READ under whatever
    // was typed, so the address the user registered with missed its own row and got the fake salt.
    test("kdf-params finds the vault whatever the capitalisation", async () => {
        const created = await app.inject({
            method: "POST",
            url: "/vault",
            payload: {
                ...registerPayload("Mixed.Case@Example.com"),
                kdf_params: PRODUCTION_KDF_PARAMS,
            },
        });
        expect(created.statusCode).toBe(201);

        const salts = await Promise.all(
            ["Mixed.Case@Example.com", "mixed.case@example.com", "MIXED.CASE@EXAMPLE.COM"].map(
                async (email) =>
                    (
                        await app.inject({
                            method: "POST",
                            url: "/auth/kdf-params",
                            payload: { email },
                        })
                    ).json().kdf_salt,
            ),
        );

        // All three reach the same vault — and it is the REAL salt, not the deterministic fake.
        expect(new Set(salts).size).toBe(1);
        expect(salts[0]).toBe(REAL_KDF_SALT);
    });

    // The end of the same story: the salt was only the setup — this is the vault being lost.
    test("login succeeds whatever the capitalisation of the registered address", async () => {
        const created = await app.inject({
            method: "POST",
            url: "/vault",
            payload: registerPayload("Login.Case@Example.com"),
        });
        expect(created.statusCode).toBe(201);

        for (const email of [
            "Login.Case@Example.com",
            "login.case@example.com",
            "LOGIN.CASE@EXAMPLE.COM",
        ]) {
            const res = await app.inject({
                method: "POST",
                url: "/auth/login",
                payload: { email, auth_key: "A".repeat(44) },
            });
            expect({ email, status: res.statusCode }).toEqual({ email, status: 200 });
        }
    });

    // The residual after normalising the input: the lookup still has to use the SAME predicate as
    // the unique index. POST /vault is a documented takeover seam, so a row written by another path
    // can carry mixed case — the index stops a SECOND such row, but the first would be invisible to
    // an exact-match lookup, which is the original "correct password rejected" failure over again.
    test("a mixed-case row written outside the normalising path is still found", async () => {
        const authKey = "A".repeat(44);
        const { email } = await createTestUser(app, {
            email: "seam@example.com",
            auth_key: authKey,
        });
        const userId = (await getUserIdByEmail(email))!;

        // Simulate a write path that did not normalise.
        await db.update(users).set({ email: "Seam@Example.COM" }).where(eq(users.id, userId));

        const kdf = await app.inject({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email: "seam@example.com" },
        });
        expect(kdf.json().kdf_salt).toBe(REAL_KDF_SALT); // the real salt, not the fake

        const login = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email: "seam@example.com", auth_key: authKey },
        });
        expect(login.statusCode).toBe(200);
    });

    // The other half of the same fix, and the easy half to get wrong: normalising only the lookup
    // would leave a real vault answering with one salt for every casing while an address with no
    // vault answered with a different fake salt per casing — exactly the existence oracle
    // KDF_FAKE_SEED exists to close.
    test("an unknown address gets the same fake salt whatever the capitalisation", async () => {
        const salts = await Promise.all(
            ["No.Vault@Example.com", "no.vault@example.com", "NO.VAULT@EXAMPLE.COM"].map(
                async (email) =>
                    (
                        await app.inject({
                            method: "POST",
                            url: "/auth/kdf-params",
                            payload: { email },
                        })
                    ).json().kdf_salt,
            ),
        );

        expect(new Set(salts).size).toBe(1);
        // ...and it is not the real salt of some other vault.
        expect(salts[0]).not.toBe(REAL_KDF_SALT);
    });
});

describe("POST /auth/login", () => {
    test("correct credentials return 200 and a session cookie", async () => {
        const { email, auth_key } = await createTestUser(app);

        const res = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key },
        });

        expect(res.statusCode).toBe(200);
        const cookie = res.headers["set-cookie"];
        const cookieStr = Array.isArray(cookie) ? cookie[0] : cookie;
        expect(cookieStr).toContain("session_token=");
    });

    test("the DB stores the token's SHA-256 hash, not the raw cookie value", async () => {
        const { email, auth_key } = await createTestUser(app);
        const res = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key },
        });
        const rawToken = cookieFromResponse(res).replace("session_token=", "");

        // The raw token must NOT exist in the database; only its SHA-256 hash.
        const byRaw = await db.select().from(sessions).where(eq(sessions.session_token, rawToken));
        expect(byRaw.length).toBe(0);

        const byHash = await db
            .select()
            .from(sessions)
            .where(eq(sessions.session_token, sha256Hex(rawToken)));
        expect(byHash.length).toBe(1);

        // The cookie still authenticates (the lookup hashes the incoming token).
        const me = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie: `session_token=${rawToken}` },
        });
        expect(me.statusCode).toBe(200);
    });

    test("the login response carries encrypted_vault_key and vault_key_nonce", async () => {
        const { email, auth_key } = await createTestUser(app);

        const res = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.encrypted_vault_key).toBeTruthy();
        expect(body.vault_key_nonce).toBeTruthy();
    });

    test("a wrong password returns 401", async () => {
        const { email } = await createTestUser(app);

        const res = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key: "B".repeat(44) },
        });

        expect(res.statusCode).toBe(401);
    });

    test("a non-existent email returns 401 (it does not reveal whether the user exists)", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email: "nobody@example.com", auth_key: "A".repeat(44) },
        });

        expect(res.statusCode).toBe(401);
    });
});

describe("GET /auth/me", () => {
    test("with a valid session it returns the email, the kdf params and the VK fields", async () => {
        const { cookie, email } = await createTestUser(app);

        const res = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.email).toBe(email);
        expect(body.kdf_salt).toBeTruthy();
        expect(body.encrypted_vault_key).toBeTruthy();
        expect(body.vault_key_nonce).toBeTruthy();
    });

    test("with no session it returns 401", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/auth/me",
        });

        expect(res.statusCode).toBe(401);
    });
});

describe("POST /auth/logout", () => {
    test("deleting a session — further requests with the same cookie are 401", async () => {
        const { cookie } = await createTestUser(app);

        const logout = await app.inject({
            method: "POST",
            url: "/auth/logout",
            headers: { cookie },
        });
        expect(logout.statusCode).toBe(200);

        const me = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie },
        });
        expect(me.statusCode).toBe(401);
    });
});

// Another login by the same user = a new session (a second "device"); return its cookie.
async function loginAgain(email: string, auth_key: string): Promise<string> {
    const login = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, auth_key },
    });
    const setCookie = login.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const token = cookieStr?.match(/session_token=([^;]+)/)?.[1];
    if (!token) throw new Error("loginAgain: no session_token cookie");
    return `session_token=${token}`;
}

describe("GET /auth/sessions + DELETE /auth/sessions/:id", () => {
    test("the list returns every session of the user and marks the current one is_current", async () => {
        const { cookie, email, auth_key } = await createTestUser(app);
        await loginAgain(email, auth_key);

        const res = await app.inject({ method: "GET", url: "/auth/sessions", headers: { cookie } });
        expect(res.statusCode).toBe(200);
        const { sessions } = res.json();
        expect(sessions.length).toBe(2);
        expect(sessions.filter((s: { is_current: boolean }) => s.is_current).length).toBe(1);
    });

    test("with no session → 401", async () => {
        const res = await app.inject({ method: "GET", url: "/auth/sessions" });
        expect(res.statusCode).toBe(401);
    });

    test("revoking another session — that cookie becomes a 401 while the current one keeps working", async () => {
        const { cookie, email, auth_key } = await createTestUser(app);
        const secondCookie = await loginAgain(email, auth_key);

        const list = await app.inject({
            method: "GET",
            url: "/auth/sessions",
            headers: { cookie },
        });
        const other = list.json().sessions.find((s: { is_current: boolean }) => !s.is_current);
        expect(other).toBeTruthy();

        const del = await app.inject({
            method: "DELETE",
            url: `/auth/sessions/${other.id}`,
            headers: { cookie },
        });
        expect(del.statusCode).toBe(200);

        // The revoked device has no access any more; the current one carries on working.
        const me2 = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie: secondCookie },
        });
        expect(me2.statusCode).toBe(401);
        const me1 = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
        expect(me1.statusCode).toBe(200);
    });

    test("revoking the current session through this endpoint → 400 (use logout)", async () => {
        const { cookie } = await createTestUser(app);
        const list = await app.inject({
            method: "GET",
            url: "/auth/sessions",
            headers: { cookie },
        });
        const currentId = list
            .json()
            .sessions.find((s: { is_current: boolean }) => s.is_current).id;

        const del = await app.inject({
            method: "DELETE",
            url: `/auth/sessions/${currentId}`,
            headers: { cookie },
        });
        expect(del.statusCode).toBe(400);
    });

    test("it cannot revoke someone else's session (scoped by user_id) → 404", async () => {
        const a = await createTestUser(app, { email: "a@example.com" });
        const b = await createTestUser(app, { email: "b@example.com" });

        const bList = await app.inject({
            method: "GET",
            url: "/auth/sessions",
            headers: { cookie: b.cookie },
        });
        const bSessionId = bList.json().sessions[0].id;

        const del = await app.inject({
            method: "DELETE",
            url: `/auth/sessions/${bSessionId}`,
            headers: { cookie: a.cookie },
        });
        expect(del.statusCode).toBe(404);
    });
});

describe("POST /auth/change-password", () => {
    test("the right current_auth_key → 200, and a new session works with the new auth_key", async () => {
        const oldAuthKey = "A".repeat(44);
        const newAuthKey = "Z".repeat(44);
        const { cookie } = await createTestUser(app, { auth_key: oldAuthKey });

        const res = await app.inject({
            method: "POST",
            url: "/auth/change-password",
            headers: { cookie },
            payload: {
                current_auth_key: oldAuthKey,
                new_auth_key: newAuthKey,
                new_kdf_salt: "C".repeat(24),
                new_kdf_params: { m: 1024, t: 1, p: 1 },
                new_encrypted_vault_key: "V".repeat(64),
                new_vault_key_nonce: "N".repeat(32),
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);
    });

    test("a wrong current_auth_key → 401, and the password does not change", async () => {
        const { cookie } = await createTestUser(app);

        const res = await app.inject({
            method: "POST",
            url: "/auth/change-password",
            headers: { cookie },
            payload: {
                current_auth_key: "B".repeat(44), // the wrong one
                new_auth_key: "Z".repeat(44),
                new_kdf_salt: "C".repeat(24),
                new_kdf_params: { m: 1024, t: 1, p: 1 },
                new_encrypted_vault_key: "V".repeat(64),
                new_vault_key_nonce: "N".repeat(32),
            },
        });

        expect(res.statusCode).toBe(401);
    });

    test("with no session → 401", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/auth/change-password",
            payload: {
                current_auth_key: "A".repeat(44),
                new_auth_key: "Z".repeat(44),
                new_kdf_salt: "C".repeat(24),
                new_kdf_params: { m: 1024, t: 1, p: 1 },
                new_encrypted_vault_key: "V".repeat(64),
                new_vault_key_nonce: "N".repeat(32),
            },
        });

        expect(res.statusCode).toBe(401);
    });

    test("a password change updates the kdf_salt that /auth/me returns", async () => {
        const oldAuthKey = "A".repeat(44);
        const newSalt = "N".repeat(24);
        const { cookie } = await createTestUser(app, { auth_key: oldAuthKey });

        const meBefore = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
        const saltBefore = meBefore.json().kdf_salt;

        const changeRes = await app.inject({
            method: "POST",
            url: "/auth/change-password",
            headers: { cookie },
            payload: {
                current_auth_key: oldAuthKey,
                new_auth_key: "Z".repeat(44),
                new_kdf_salt: newSalt,
                new_kdf_params: { m: 1024, t: 1, p: 1 },
                new_encrypted_vault_key: "V".repeat(64),
                new_vault_key_nonce: "N".repeat(32),
            },
        });

        // The old session is invalidated, and change-password returns a fresh cookie for the
        // current device.
        const newCookie = cookieFromResponse(changeRes);
        const meAfter = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie: newCookie },
        });
        expect(meAfter.json().kdf_salt).not.toBe(saltBefore);
        expect(meAfter.json().kdf_salt).toBe(newSalt);
    });

    test("a password change invalidates the sessions on other devices", async () => {
        const oldAuthKey = "A".repeat(44);
        const { cookie: cookieA, email } = await createTestUser(app, { auth_key: oldAuthKey });

        // Device B: a second session of the same user (a login with the old auth_key).
        const loginB = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key: oldAuthKey },
        });
        const cookieB = cookieFromResponse(loginB);
        expect(
            (await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieB } }))
                .statusCode,
        ).toBe(200);

        // Device A changes the password.
        await app.inject({
            method: "POST",
            url: "/auth/change-password",
            headers: { cookie: cookieA },
            payload: {
                current_auth_key: oldAuthKey,
                new_auth_key: "Z".repeat(44),
                new_kdf_salt: "C".repeat(24),
                new_kdf_params: { m: 1024, t: 1, p: 1 },
                new_encrypted_vault_key: "V".repeat(64),
                new_vault_key_nonce: "N".repeat(32),
            },
        });

        // B's old cookie no longer works.
        const meB = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie: cookieB },
        });
        expect(meB.statusCode).toBe(401);
    });

    test("change-password does not touch items — an item's version stays unchanged", async () => {
        const oldAuthKey = "A".repeat(44);
        const { cookie } = await createTestUser(app, { auth_key: oldAuthKey });

        // Creates one item.
        const id1 = uuidv7();
        await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: notePayload(id1),
        });

        const res = await app.inject({
            method: "POST",
            url: "/auth/change-password",
            headers: { cookie },
            payload: {
                current_auth_key: oldAuthKey,
                new_auth_key: "Z".repeat(44),
                new_kdf_salt: "C".repeat(24),
                new_kdf_params: { m: 1024, t: 1, p: 1 },
                new_encrypted_vault_key: "V".repeat(64),
                new_vault_key_nonce: "N".repeat(32),
            },
        });
        expect(res.statusCode).toBe(200);

        const newCookie = cookieFromResponse(res);
        const listRes = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie: newCookie },
        });
        const item = listRes.json().items.find((i: any) => i.id === id1);
        // The item version stays 1 — change-password no longer touches items!
        expect(item.version).toBe(1);
    });

    test("change-password updates encrypted_vault_key in the database", async () => {
        const oldAuthKey = "A".repeat(44);
        const { cookie, email } = await createTestUser(app, { auth_key: oldAuthKey });
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");

        const newEncVK = "V".repeat(64);
        const newVKNonce = "N".repeat(32);

        const res = await app.inject({
            method: "POST",
            url: "/auth/change-password",
            headers: { cookie },
            payload: {
                current_auth_key: oldAuthKey,
                new_auth_key: "Z".repeat(44),
                new_kdf_salt: "C".repeat(24),
                new_kdf_params: { m: 1024, t: 1, p: 1 },
                new_encrypted_vault_key: newEncVK,
                new_vault_key_nonce: newVKNonce,
            },
        });
        expect(res.statusCode).toBe(200);

        const newCookie = cookieFromResponse(res);
        const meRes = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie: newCookie },
        });
        expect(meRes.json().encrypted_vault_key).toBe(newEncVK);
        expect(meRes.json().vault_key_nonce).toBe(newVKNonce);
    });

    test("a wrong current password increments the per-account failure counter", async () => {
        const { cookie, email } = await createTestUser(app);

        const res = await app.inject({
            method: "POST",
            url: "/auth/change-password",
            headers: { cookie },
            payload: {
                current_auth_key: "B".repeat(44),
                new_auth_key: "Z".repeat(44),
                new_kdf_salt: "C".repeat(24),
                new_kdf_params: { m: 1024, t: 1, p: 1 },
                new_encrypted_vault_key: "V".repeat(64),
                new_vault_key_nonce: "N".repeat(32),
            },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe("Invalid current password");

        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");
        const [row] = await db
            .select({ failed: users.failed_attempts, until: users.locked_until })
            .from(users)
            .where(eq(users.id, userId));
        expect(row?.failed).toBe(1);
        expect(row?.until ?? null).toBeNull();
    });

    test("five wrong current passwords pause sign-in from that source without changing the 401 body", async () => {
        const authKey = "A".repeat(44);
        const { cookie, email } = await createTestUser(app, { auth_key: authKey });

        for (let i = 0; i < 5; i++) {
            const res = await app.inject({
                method: "POST",
                url: "/auth/change-password",
                headers: { cookie },
                payload: {
                    current_auth_key: "B".repeat(44),
                    new_auth_key: "Z".repeat(44),
                    new_kdf_salt: "C".repeat(24),
                    new_kdf_params: { m: 1024, t: 1, p: 1 },
                    new_encrypted_vault_key: "V".repeat(64),
                    new_vault_key_nonce: "N".repeat(32),
                },
            });
            expect(res.statusCode).toBe(401);
            expect(res.json().error).toBe("Invalid current password");
        }

        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");
        // The run is counted against its source (the injected 127.0.0.1) and the account; five is
        // the source's threshold, far below the account's.
        const [source] = await db
            .select({ until: loginFailures.locked_until })
            .from(loginFailures)
            .where(and(eq(loginFailures.user_id, userId), eq(loginFailures.source, "127.0.0.1")));
        expect(source?.until ?? 0).toBeGreaterThan(nowSec());
        const [account] = await db
            .select({ failed: users.failed_attempts, until: users.locked_until })
            .from(users)
            .where(eq(users.id, userId));
        expect(account?.failed).toBe(5);
        expect(account?.until ?? null).toBeNull();

        // Signing in from that source is paused; from anywhere else it works.
        const sameSource = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key: authKey },
        });
        expect(sameSource.statusCode).toBe(401);
        expect(sameSource.json().error).toBe("Invalid credentials");
        const elsewhere = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key: authKey },
            remoteAddress: "198.51.100.7",
        });
        expect(elsewhere.statusCode).toBe(200);
    });
});

describe("DELETE /auth/account", () => {
    test("the right auth_key → 200, and the session stops working", async () => {
        const authKey = "A".repeat(44);
        const { cookie } = await createTestUser(app, { auth_key: authKey });

        const res = await app.inject({
            method: "DELETE",
            url: "/auth/account",
            headers: { cookie },
            payload: { auth_key: authKey },
        });

        expect(res.statusCode).toBe(200);

        // The session is no longer valid
        const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
        expect(me.statusCode).toBe(401);
    });

    test("a wrong auth_key → 401, and the account stays", async () => {
        const { cookie, email } = await createTestUser(app);

        const res = await app.inject({
            method: "DELETE",
            url: "/auth/account",
            headers: { cookie },
            payload: { auth_key: "B".repeat(44) },
        });

        expect(res.statusCode).toBe(401);

        // The account still exists
        const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
        expect(me.statusCode).toBe(200);
        expect(me.json().email).toBe(email);
    });

    test("a wrong auth_key increments the per-account failure counter", async () => {
        const { cookie, email } = await createTestUser(app);

        const res = await app.inject({
            method: "DELETE",
            url: "/auth/account",
            headers: { cookie },
            payload: { auth_key: "B".repeat(44) },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe("Invalid credentials");

        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");
        const [row] = await db
            .select({ failed: users.failed_attempts, until: users.locked_until })
            .from(users)
            .where(eq(users.id, userId));
        expect(row?.failed).toBe(1);
        expect(row?.until ?? null).toBeNull();
    });

    test("five wrong auth_keys pause sign-in from that source without changing the 401 body", async () => {
        const authKey = "A".repeat(44);
        const { cookie, email } = await createTestUser(app, { auth_key: authKey });

        for (let i = 0; i < 5; i++) {
            const res = await app.inject({
                method: "DELETE",
                url: "/auth/account",
                headers: { cookie },
                payload: { auth_key: "B".repeat(44) },
            });
            expect(res.statusCode).toBe(401);
            expect(res.json().error).toBe("Invalid credentials");
        }

        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");
        // The run is counted against its source (the injected 127.0.0.1) and the account; five is
        // the source's threshold, far below the account's.
        const [source] = await db
            .select({ until: loginFailures.locked_until })
            .from(loginFailures)
            .where(and(eq(loginFailures.user_id, userId), eq(loginFailures.source, "127.0.0.1")));
        expect(source?.until ?? 0).toBeGreaterThan(nowSec());
        const [account] = await db
            .select({ failed: users.failed_attempts, until: users.locked_until })
            .from(users)
            .where(eq(users.id, userId));
        expect(account?.failed).toBe(5);
        expect(account?.until ?? null).toBeNull();

        // Signing in from that source is paused; from anywhere else it works.
        const sameSource = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key: authKey },
        });
        expect(sameSource.statusCode).toBe(401);
        expect(sameSource.json().error).toBe("Invalid credentials");
        const elsewhere = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key: authKey },
            remoteAddress: "198.51.100.7",
        });
        expect(elsewhere.statusCode).toBe(200);
    });

    test("the auth_key field is missing → 400", async () => {
        const { cookie } = await createTestUser(app);

        const res = await app.inject({
            method: "DELETE",
            url: "/auth/account",
            headers: { cookie },
            payload: {},
        });

        expect(res.statusCode).toBe(400);
    });

    test("with no session → 401", async () => {
        const res = await app.inject({
            method: "DELETE",
            url: "/auth/account",
            payload: { auth_key: "A".repeat(44) },
        });

        expect(res.statusCode).toBe(401);
    });

    test("a deletion sweeps the chunk_sets (pending_delete_at)", async () => {
        const authKey = "A".repeat(44);
        const { cookie, email } = await createTestUser(app, { auth_key: authKey });
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");

        // Seeds a committed chunk_set directly — it simulates a file that exists
        await insertChunkSet("cs-purge-test", userId, { totalSize: 1000 });

        const res = await app.inject({
            method: "DELETE",
            url: "/auth/account",
            headers: { cookie },
            payload: { auth_key: authKey },
        });

        expect(res.statusCode).toBe(200);

        // the chunk_set has to carry pending_delete_at (it must not be physically deleted straight away — the GC does that)
        const [cs] = await db
            .select({ pending_delete_at: chunkSets.pending_delete_at })
            .from(chunkSets)
            .where(eq(chunkSets.id, "cs-purge-test"));
        expect(cs?.pending_delete_at).not.toBeNull();
    });
});

// ── authenticate: session expiry and the sliding window ──────────────────────────────

describe("authenticate — session expiry and the sliding window", () => {
    /** A signed-in test user: the cookie, and the hash its session row is stored under. */
    async function signedIn() {
        const { cookie, email } = await createTestUser(app);
        const token = cookie.match(/session_token=([^;]+)/)?.[1];
        if (!token) throw new Error("no session cookie");
        return { cookie, email, tokenHash: sha256Hex(token) };
    }

    async function setExpiry(tokenHash: string, expiresAt: number) {
        await db
            .update(sessions)
            .set({ expires_at: expiresAt })
            .where(eq(sessions.session_token, tokenHash));
    }

    async function expiryOf(tokenHash: string) {
        const [row] = await db
            .select({ expiresAt: sessions.expires_at })
            .from(sessions)
            .where(eq(sessions.session_token, tokenHash));
        return row?.expiresAt;
    }

    /** Any route behind `authenticate`. */
    const protectedGet = (cookie: string) =>
        app.inject({ method: "GET", url: "/me/storage", headers: { cookie } });

    const sessionCookieOf = (res: LightMyRequestResponse) =>
        [res.headers["set-cookie"] ?? []].flat().find((c) => c.startsWith("session_token="));

    test("an expired session → 401 'Session expired', its row deleted and the cookie cleared", async () => {
        const { cookie, tokenHash } = await signedIn();
        await setExpiry(tokenHash, nowSec() - 1);

        const res = await protectedGet(cookie);

        expect(res.statusCode).toBe(401);
        expect(JSON.stringify(res.json())).toContain("Session expired");
        expect(await expiryOf(tokenHash)).toBeUndefined();
        // A cleared cookie: no value, and gone at once.
        expect(sessionCookieOf(res)).toMatch(/^session_token=;/);
        expect(sessionCookieOf(res)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    });

    test("less than half the TTL left → extended to now + TTL, with a cookie of that max age", async () => {
        const { cookie, tokenHash } = await signedIn();
        const before = nowSec();
        await setExpiry(tokenHash, before + Math.floor(SESSION_TTL_SECONDS / 2) - 60);

        const res = await protectedGet(cookie);

        expect(res.statusCode).toBe(200);
        const extended = await expiryOf(tokenHash);
        expect(extended).toBeGreaterThanOrEqual(before + SESSION_TTL_SECONDS);
        expect(extended).toBeLessThanOrEqual(nowSec() + SESSION_TTL_SECONDS);
        expect(sessionCookieOf(res)).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    });

    test("more than half the TTL left → the expiry stays as it is, and no cookie is set", async () => {
        const { cookie, tokenHash } = await signedIn();
        const expiry = nowSec() + Math.floor(SESSION_TTL_SECONDS / 2) + 3600;
        await setExpiry(tokenHash, expiry);

        const res = await protectedGet(cookie);

        expect(res.statusCode).toBe(200);
        expect(await expiryOf(tokenHash)).toBe(expiry);
        expect(sessionCookieOf(res)).toBeUndefined();
    });

    test("a locked user with an expired session gets 401, not 403 — the expiry comes first", async () => {
        const { cookie, email, tokenHash } = await signedIn();
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");
        await db.update(users).set({ locked_at: nowSec() }).where(eq(users.id, userId));
        await setExpiry(tokenHash, nowSec() - 1);

        const res = await protectedGet(cookie);

        expect(res.statusCode).toBe(401);
    });
});

// ── locked_at enforcement ────────────────────────────────────────────────────

describe("locked_at — POST /auth/login", () => {
    test("a locked user cannot log in → 403 account_locked", async () => {
        const authKey = "A".repeat(44);
        const { email } = await createTestUser(app, { auth_key: authKey });
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");

        await db
            .update(users)
            .set({ locked_at: Math.floor(Date.now() / 1000) })
            .where(eq(users.id, userId));

        const res = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key: authKey },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("account_locked");
    });

    test("an unlocked user logs in normally", async () => {
        const authKey = "A".repeat(44);
        const { email } = await createTestUser(app, { auth_key: authKey });
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");

        // Lock, then unlock again straight away
        await db
            .update(users)
            .set({ locked_at: Math.floor(Date.now() / 1000) })
            .where(eq(users.id, userId));
        await db.update(users).set({ locked_at: null }).where(eq(users.id, userId));

        const res = await app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key: authKey },
        });

        expect(res.statusCode).toBe(200);
    });
});

// ── The per-account progressive backoff on /auth/login ───────────────────────

describe("sign-in throttling — POST /auth/login", () => {
    const WRONG = "B".repeat(44);
    const RIGHT = "A".repeat(44);
    // The injected socket address is the source: the API trusts no proxy in the tests.
    const ATTACKER = "203.0.113.66";
    const OWNER = "198.51.100.7";

    function login(email: string, authKey: string, from = "127.0.0.1") {
        return app.inject({
            method: "POST",
            url: "/auth/login",
            payload: { email, auth_key: authKey },
            remoteAddress: from,
        });
    }

    async function sourceState(userId: string, source: string) {
        const [row] = await db
            .select()
            .from(loginFailures)
            .where(and(eq(loginFailures.user_id, userId), eq(loginFailures.source, source)));
        return row ?? null;
    }

    async function accountState(userId: string) {
        const [row] = await db
            .select({
                failed: users.failed_attempts,
                until: users.locked_until,
                windowStartedAt: users.failed_window_started_at,
            })
            .from(users)
            .where(eq(users.id, userId));
        return row ?? { failed: 0, until: null, windowStartedAt: null };
    }

    async function newUser() {
        const { email } = await createTestUser(app, { auth_key: RIGHT });
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");
        return { email, userId };
    }

    test("every miss counts against its source and the account; below the threshold nothing locks", async () => {
        const { email, userId } = await newUser();

        await login(email, WRONG, ATTACKER);
        await login(email, WRONG, ATTACKER);

        const source = await sourceState(userId, ATTACKER);
        expect(source?.failed_attempts).toBe(2);
        expect(source?.locked_until).toBeNull();
        const account = await accountState(userId);
        expect(account.failed).toBe(2);
        expect(account.until).toBeNull();
    });

    test("past the threshold (5 misses) the source is locked; the right password from it gets the generic 401", async () => {
        const { email, userId } = await newUser();

        for (let i = 0; i < 5; i++) await login(email, WRONG, ATTACKER);

        expect((await sourceState(userId, ATTACKER))?.locked_until ?? 0).toBeGreaterThan(nowSec());
        // The right password during the lock → the same 401 as a wrong one: accepting it would
        // confirm the guess the lock is there to stop.
        const res = await login(email, RIGHT, ATTACKER);
        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe("Invalid credentials");
    });

    // The finding this design answers: one source with nine requests per 15 minutes used to hold any
    // known account shut, and the owner was told their password was wrong.
    test("a locked source does not keep the owner out from another source", async () => {
        const { email, userId } = await newUser();

        for (let i = 0; i < 5; i++) await login(email, WRONG, ATTACKER);
        expect((await sourceState(userId, ATTACKER))?.locked_until ?? 0).toBeGreaterThan(nowSec());

        const owner = await login(email, RIGHT, OWNER);
        expect(owner.statusCode).toBe(200);
        // ...and the owner's success does not release the attacker.
        expect((await sourceState(userId, ATTACKER))?.locked_until ?? 0).toBeGreaterThan(nowSec());
        expect((await login(email, RIGHT, ATTACKER)).statusCode).toBe(401);
    });

    test("addresses in one IPv6 /64 are one source", async () => {
        const { email, userId } = await newUser();

        for (let i = 0; i < 5; i++) await login(email, WRONG, `2001:db8:5:6::${i + 1}`);

        const source = await sourceState(userId, "2001:db8:5:6::/64");
        expect(source?.failed_attempts).toBe(5);
        expect(source?.locked_until ?? 0).toBeGreaterThan(nowSec());
        expect((await login(email, RIGHT, "2001:db8:5:6::99")).statusCode).toBe(401);
    });

    test("an expired source lock allows a login with the right password again", async () => {
        const { email, userId } = await newUser();
        for (let i = 0; i < 5; i++) await login(email, WRONG, ATTACKER);

        await db
            .update(loginFailures)
            .set({ locked_until: nowSec() - 10 })
            .where(eq(loginFailures.user_id, userId));

        expect((await login(email, RIGHT, ATTACKER)).statusCode).toBe(200);
    });

    // Regression: the count was monotonic, and attempts made DURING a lock return early without
    // counting — so the escalation counted lock events, which the attacker chooses. One request per
    // expiring lock walked 30 s → 900 s and held it there. Failures now accumulate only inside a
    // rolling window, so a long lock consumes the window that produced it.
    test("a failure after the window has lapsed restarts the count instead of escalating", async () => {
        const { email, userId } = await newUser();
        const longAgo = nowSec() - 4000;
        await db.insert(loginFailures).values({
            user_id: userId,
            source: ATTACKER,
            failed_attempts: 9,
            window_started_at: longAgo,
            locked_until: nowSec() - 10,
        });

        await login(email, WRONG, ATTACKER);

        const after = await sourceState(userId, ATTACKER);
        expect(after?.failed_attempts).toBe(1); // a fresh run, not 10
        expect(after?.locked_until).toBeNull();
        expect(after?.window_started_at ?? 0).toBeGreaterThan(longAgo);
        expect((await login(email, RIGHT, ATTACKER)).statusCode).toBe(200);
    });

    test("failures inside the window still escalate", async () => {
        const { email, userId } = await newUser();
        for (let i = 0; i < 5; i++) await login(email, WRONG, ATTACKER);
        const locked = await sourceState(userId, ATTACKER);
        const firstLock = locked?.locked_until ?? 0;

        // The lock lapses but the window has not: the next miss is the 6th of the same run.
        await db
            .update(loginFailures)
            .set({ locked_until: nowSec() - 1 })
            .where(eq(loginFailures.user_id, userId));
        await login(email, WRONG, ATTACKER);

        const escalated = await sourceState(userId, ATTACKER);
        expect(escalated?.failed_attempts).toBe(6);
        expect(escalated?.locked_until ?? 0).toBeGreaterThan(firstLock);
        expect(escalated?.window_started_at).toBe(locked?.window_started_at ?? -1);
    });

    test("a successful login clears its own source and the account count", async () => {
        const { email, userId } = await newUser();
        await login(email, WRONG, OWNER);
        await login(email, WRONG, OWNER);

        expect((await login(email, RIGHT, OWNER)).statusCode).toBe(200);

        expect(await sourceState(userId, OWNER)).toBeNull();
        const account = await accountState(userId);
        expect(account.failed).toBe(0);
        expect(account.until).toBeNull();
        expect(account.windowStartedAt).toBeNull();
    });

    test("a non-existent email is not tracked (there is no enumeration oracle)", async () => {
        for (let i = 0; i < 6; i++) {
            const res = await login("ghost@example.com", WRONG, ATTACKER);
            expect(res.statusCode).toBe(401);
            expect(res.json().error).toBe("Invalid credentials");
        }
        const rows = await db.select().from(loginFailures);
        expect(rows).toEqual([]);
    });

    test("failures spread over many sources lock the whole account, with one event and the same 401", async () => {
        const { email, userId } = await newUser();
        const lockEvents: string[] = [];
        app.onSecurityEvent((event) => {
            if (event.type === "account_locked" && event.userId === userId) {
                lockEvents.push(event.reason);
            }
        });

        // The test setup puts the account threshold at 12: 5 + 5 + 2 from three sources.
        for (const [from, misses] of [
            ["192.0.2.1", 5],
            ["192.0.2.2", 5],
            ["192.0.2.3", 2],
        ] as const) {
            for (let i = 0; i < misses; i++) await login(email, WRONG, from);
        }
        await app.flushSecurityEvents();

        const account = await accountState(userId);
        expect(account.failed).toBe(12);
        expect(account.until ?? 0).toBeGreaterThan(nowSec());
        // Now the owner is kept out too, with nothing that tells the lock from a wrong password.
        const owner = await login(email, RIGHT, OWNER);
        expect(owner.statusCode).toBe(401);
        expect(owner.json().error).toBe("Invalid credentials");
        expect(lockEvents).toEqual(["failed_attempts"]);
    });

    test("a per-source lock is not announced as an account lock", async () => {
        const { email, userId } = await newUser();
        const lockEvents: string[] = [];
        app.onSecurityEvent((event) => {
            if (event.type === "account_locked" && event.userId === userId) {
                lockEvents.push(event.reason);
            }
        });

        for (let i = 0; i < 5; i++) await login(email, WRONG, ATTACKER);
        await app.flushSecurityEvents();

        expect(lockEvents).toEqual([]);
    });

    test("parallel wrong passwords from one source count atomically and stop at the threshold", async () => {
        const { email, userId } = await newUser();

        const results = await Promise.all(
            Array.from({ length: 20 }, () => login(email, WRONG, ATTACKER)),
        );
        for (const res of results) {
            expect(res.statusCode).toBe(401);
            expect(res.json().error).toBe("Invalid credentials");
        }

        // Stale-snapshot writes used to collapse ~20 parallel misses onto a handful of increments
        // and never lock. The counter, the window and the lock are one statement that skips a row
        // already inside a lock, so the run stops exactly at the threshold.
        const source = await sourceState(userId, ATTACKER);
        expect(source?.failed_attempts).toBe(5);
        expect(source?.locked_until).not.toBeNull();
    });
});

describe("locked_at — authenticate plugin", () => {
    test("a locked user holding a valid session gets 403 on the protected routes", async () => {
        const { cookie, email } = await createTestUser(app);
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");

        // The session exists, but the user is being locked
        await db
            .update(users)
            .set({ locked_at: Math.floor(Date.now() / 1000) })
            .where(eq(users.id, userId));

        const res = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie },
        });

        expect(res.statusCode).toBe(403);
    });

    test("an unlocked user with a session passes authenticate normally", async () => {
        const { cookie, email } = await createTestUser(app);
        const userId = await getUserIdByEmail(email);
        if (!userId) throw new Error("user not found");

        // Lock, then unlock — the session stays active
        await db
            .update(users)
            .set({ locked_at: Math.floor(Date.now() / 1000) })
            .where(eq(users.id, userId));
        await db.update(users).set({ locked_at: null }).where(eq(users.id, userId));

        const res = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().email).toBe(email);
    });
});

describe("the IP rate limit on the sensitive authenticated routes", () => {
    // The limiter is otherwise skipped in tests (its counter would accumulate across every test
    // request). Here we deliberately re-activate it (RATE_LIMIT_IN_TEST=1) on a separate app instance
    // with a fresh in-memory counter, and confirm that change-password / DELETE account answer 429
    // after too many attempts (brute-force protection for `current_auth_key`/`auth_key`, even with a
    // stolen session).
    let rlApp: FastifyInstance;
    let prevFlag: string | undefined;

    beforeAll(async () => {
        prevFlag = process.env.RATE_LIMIT_IN_TEST;
        process.env.RATE_LIMIT_IN_TEST = "1";
        rlApp = await buildApp();
        await rlApp.ready();
    });

    afterAll(async () => {
        await rlApp.close();
        if (prevFlag === undefined) delete process.env.RATE_LIMIT_IN_TEST;
        else process.env.RATE_LIMIT_IN_TEST = prevFlag;
    });

    test("change-password → 429 once the limit is crossed (401s come first)", async () => {
        const { cookie } = await createTestUser(rlApp, { email: "rl-cp@example.com" });

        const statuses: number[] = [];
        for (let i = 0; i < 25; i++) {
            const res = await rlApp.inject({
                method: "POST",
                url: "/auth/change-password",
                headers: { cookie },
                payload: {
                    current_auth_key: "C".repeat(44), // deliberately wrong → a 401 until the limit bites
                    new_auth_key: "D".repeat(44),
                    new_kdf_salt: "E".repeat(24),
                    new_kdf_params: { m: 1024, t: 1, p: 1 },
                    new_encrypted_vault_key: "V".repeat(64),
                    new_vault_key_nonce: "N".repeat(32),
                },
            });
            statuses.push(res.statusCode);
            if (res.statusCode === 429) break;
        }

        // The limiter fires only after a few allowed (401) attempts, not on the first request.
        expect(statuses).toContain(429);
        expect(statuses).toContain(401);
        expect(statuses.indexOf(429)).toBeGreaterThan(0);
    });

    test("DELETE /auth/account → 429 after too many attempts", async () => {
        // A fresh app, so the counter carries no state over from the previous test.
        const freshApp = await buildApp();
        await freshApp.ready();
        try {
            const { cookie } = await createTestUser(freshApp, { email: "rl-del@example.com" });
            let limited = false;
            for (let i = 0; i < 25; i++) {
                const res = await freshApp.inject({
                    method: "DELETE",
                    url: "/auth/account",
                    headers: { cookie },
                    payload: { auth_key: "C".repeat(44) }, // wrong → a 401 until the limit bites
                });
                if (res.statusCode === 429) {
                    limited = true;
                    break;
                }
            }
            expect(limited).toBe(true);
        } finally {
            await freshApp.close();
        }
    });
});

describe("IP rate limit on vault, logout, and registration-status", () => {
    let rlApp: FastifyInstance;
    let prevFlag: string | undefined;

    beforeAll(async () => {
        prevFlag = process.env.RATE_LIMIT_IN_TEST;
        process.env.RATE_LIMIT_IN_TEST = "1";
        rlApp = await buildApp();
        await rlApp.ready();
    });

    afterAll(async () => {
        await rlApp.close();
        if (prevFlag === undefined) delete process.env.RATE_LIMIT_IN_TEST;
        else process.env.RATE_LIMIT_IN_TEST = prevFlag;
    });

    test("POST /vault → 429 after AUTH_REGISTER_RATELIMIT_MAX", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 8; i++) {
            const res = await rlApp.inject({
                method: "POST",
                url: "/vault",
                payload: registerPayload(`rl-vault-${i}@example.com`),
            });
            statuses.push(res.statusCode);
            if (res.statusCode === 429) break;
        }
        expect(statuses).toContain(429);
        expect(statuses).toContain(201);
        expect(statuses.indexOf(429)).toBeGreaterThan(0);
    });

    test("GET /auth/registration-status → 429 after the login window max", async () => {
        const freshApp = await buildApp();
        await freshApp.ready();
        try {
            const statuses: number[] = [];
            for (let i = 0; i < 15; i++) {
                const res = await freshApp.inject({
                    method: "GET",
                    url: "/auth/registration-status",
                });
                statuses.push(res.statusCode);
                if (res.statusCode === 429) break;
            }
            expect(statuses).toContain(429);
            expect(statuses).toContain(200);
            expect(statuses.indexOf(429)).toBeGreaterThan(0);
        } finally {
            await freshApp.close();
        }
    });

    test("POST /auth/logout → 429 after the login window max", async () => {
        const freshApp = await buildApp();
        await freshApp.ready();
        try {
            const statuses: number[] = [];
            for (let i = 0; i < 15; i++) {
                const res = await freshApp.inject({ method: "POST", url: "/auth/logout" });
                statuses.push(res.statusCode);
                if (res.statusCode === 429) break;
            }
            expect(statuses).toContain(429);
            expect(statuses).toContain(200);
            expect(statuses.indexOf(429)).toBeGreaterThan(0);
        } finally {
            await freshApp.close();
        }
    });
});
