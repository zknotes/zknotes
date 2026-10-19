import { randomBytes } from "node:crypto";
import {
    assertKdfParamsFloor,
    ChangePasswordSchema,
    generateDeterministicFakeKdfMetadata,
    type KdfParams,
    LoginSchema,
    normalizeEmail,
    z,
} from "@zknotes/shared";
// The DeleteAccount body — the same auth_key format as login.
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { uuidv7 } from "uuidv7";
import { db } from "../db";
import { sessions, users } from "../db/schema";
import { OPEN_REGISTRATION, type RegistrationStatus } from "../entitlements";
import { AUTH_BODY_LIMIT, authResponseFloor } from "../lib/auth-floor";
import {
    authenticatedRouteOptions,
    authRateLimitWindow,
    ipRateLimit,
    rateLimitKey,
} from "../lib/rate-limit";
import { assertProductionSecret } from "../lib/secrets";
import {
    clearSessionCookie,
    hashSessionToken,
    SESSION_COOKIE,
    SESSION_COOKIE_BASE,
    SESSION_TTL_SECONDS,
} from "../lib/session-token";
import { nowSec } from "../lib/time";
import { parseBody } from "../lib/validate";
import { bufToB64, requireB64ToBuf } from "../lib/wire";
import { requireUserId } from "../plugins/auth";
import { recordLoginFailure, recordLoginSuccess } from "../services/analytics/collector";
import { Argon2BacklogError, hashAuthKey, verifyAuthKey } from "../services/auth-service";
import {
    clearSignInFailures,
    isSignInLocked,
    recordSignInFailure,
} from "../services/login-throttle";
import { purgeUserData } from "../services/uploads-service";

export { DEFAULT_AUTH_JITTER_MS } from "../lib/auth-floor";
const KDF_FAKE_DEV_SEED = "dev-fake-seed-change-in-prod";
const KDF_FAKE_SEED = process.env.KDF_FAKE_SEED || KDF_FAKE_DEV_SEED;

// The IP rate limit for the unauthenticated auth routes (anti-brute-force, and anti-enumeration slowdown).
const RL_WINDOW = authRateLimitWindow();
const RL_LOGIN_MAX = Number(process.env.AUTH_LOGIN_RATELIMIT_MAX ?? 10);
// A throttle for authenticated sensitive routes (change-password / DELETE account) — it limits
// brute-forcing `current_auth_key`/`auth_key` even with a stolen session.
const RL_SENSITIVE_MAX = Number(process.env.AUTH_SENSITIVE_RATELIMIT_MAX ?? 10);

/** The options every credential route shares: the response floor and a small body limit. */
const credentialRoute = { ...authResponseFloor, bodyLimit: AUTH_BODY_LIMIT };

function emitAccountLock(
    fastify: { emitSecurityEvent: FastifyInstance["emitSecurityEvent"] },
    userId: string,
    accountLocked: boolean,
): void {
    if (accountLocked) {
        fastify.emitSecurityEvent({
            type: "account_locked",
            userId,
            reason: "failed_attempts",
        });
    }
}

// The fake salt is an HMAC over this seed: a guessable seed would let anyone tell a real salt from a
// fake one, which is exactly what it exists to prevent.
if (process.env.NODE_ENV === "production") {
    assertProductionSecret("KDF_FAKE_SEED", process.env.KDF_FAKE_SEED, KDF_FAKE_DEV_SEED);
}

/**
 * Look a vault up by address, matching on `lower(email)` — the same predicate as the unique index,
 * and the reason that index exists.
 *
 * Normalising the input is not enough on its own: `POST /vault` is a documented takeover seam, so a
 * row written by some other path can still carry mixed case. The index stops a second such row, but
 * the first would be invisible to an exact-match lookup — the original "correct password rejected"
 * failure, just narrowed to a leftover row. `email` is already normalised by the caller.
 */
function findUserByEmail(email: string) {
    return db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
}

async function verifyUserAuthKey(userId: string, suppliedKey: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return { ok: false as const, user: null };
    return { ok: await verifyAuthKey(user.auth_key_hash, suppliedKey), user };
}

async function issueSession(
    reply: FastifyReply,
    userId: string,
    request?: FastifyRequest,
): Promise<number> {
    const sessionToken = randomBytes(32).toString("hex");
    const expiresAt = nowSec() + SESSION_TTL_SECONDS;
    const sessionId = uuidv7();

    const now = nowSec();
    await db.insert(sessions).values({
        id: sessionId,
        // The DB stores the hash, the cookie carries the raw token.
        session_token: hashSessionToken(sessionToken),
        user_id: userId,
        expires_at: expiresAt,
        user_agent: request?.headers["user-agent"] ?? null,
        ip_address: request?.ip ?? null,
    });
    // last_seen on sign-in.
    await db.update(users).set({ last_seen_at: now }).where(eq(users.id, userId));

    reply.setCookie(SESSION_COOKIE, sessionToken, {
        ...SESSION_COOKIE_BASE,
        maxAge: SESSION_TTL_SECONDS,
    });
    return expiresAt;
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
    let dummyAuthHash = "";
    fastify.addHook("onReady", async () => {
        dummyAuthHash = await hashAuthKey("dummy_key");
    });

    const { read: authRead, mut: authMut, userMutRl } = authenticatedRouteOptions(fastify);

    // Public registration status for the register UI (disabling the form, count/cap).
    // A read-only COUNT — no enumeration risk, hence no auth timing defence.
    // Seam 3: an extension may take this route over. The core registers a minimal version only if
    // nobody has claimed it — extensions load before the core's own routes.
    if (!fastify.hasRoute({ method: "GET", url: "/auth/registration-status" })) {
        fastify.get(
            "/auth/registration-status",
            { config: { rateLimit: ipRateLimit(RL_LOGIN_MAX, RL_WINDOW) } },
            async () => {
                return (await fastify.entitlements.registrationStatus?.(db)) ?? OPEN_REGISTRATION;
            },
        );
    }

    fastify.post(
        "/auth/kdf-params",
        { ...credentialRoute, config: { rateLimit: ipRateLimit(RL_LOGIN_MAX, RL_WINDOW) } },
        async (request, reply) => {
            const data = parseBody(z.object({ email: z.email().max(254) }), request, reply);
            if (!data) return;
            // A vault is stored under the normalised address (vault-service.ts), so the lookup has to
            // normalise too — otherwise "Alice@Example.com" misses the row it created and the caller
            // is handed the fake salt for their own account, derives the wrong Master Key, and is
            // told their correct password is invalid. There is no recovery from that.
            //
            // The SAME value has to feed the fake branch below. Normalising only the lookup would
            // leave a real account returning one salt for every casing while a nonexistent one
            // returned a different salt per casing — a clean existence oracle, which is the whole
            // thing KDF_FAKE_SEED exists to prevent.
            const email = normalizeEmail(data.email);

            const [user] = await findUserByEmail(email);
            let saltBase64: string;
            let params: KdfParams;

            if (user) {
                saltBase64 = bufToB64(user.kdf_salt) ?? "";
                params = JSON.parse(user.kdf_params) as KdfParams;
            } else {
                const fakeMetadata = generateDeterministicFakeKdfMetadata(email, KDF_FAKE_SEED);
                saltBase64 = bufToB64(fakeMetadata.salt) ?? "";
                params = fakeMetadata.params;
            }

            return reply.send({ kdf_salt: saltBase64, kdf_params: params });
        },
    );

    fastify.post(
        "/auth/login",
        { ...credentialRoute, config: { rateLimit: ipRateLimit(RL_LOGIN_MAX, RL_WINDOW) } },
        async (request, reply) => {
            const data = parseBody(LoginSchema, request, reply);
            if (!data) return;
            // Normalised for the same reason as /auth/kdf-params above — a vault is stored under the
            // normalised address, so anything else misses its own row and 401s on a correct password.
            const email = normalizeEmail(data.email);
            const { auth_key } = data;
            // The source a failure counts against: the same subject the per-IP rate limit uses.
            const source = rateLimitKey(request);
            try {
                const now = nowSec();
                const [user] = await findUserByEmail(email);

                // Inside a lock — this source's, or the account-wide one → answer exactly as for a
                // wrong password, and spend the same verify cost so the timing matches too. The
                // right password is not checked: accepting it here would confirm a guess, which is
                // what the lock is for.
                if (user && (await isSignInLocked(user, source, now))) {
                    await verifyAuthKey(dummyAuthHash, auth_key);
                    recordLoginFailure();
                    return reply.status(401).send({ error: "Invalid credentials" });
                }

                let valid = false;
                if (user) {
                    valid = await verifyAuthKey(user.auth_key_hash, auth_key);
                } else {
                    await verifyAuthKey(dummyAuthHash, auth_key);
                }

                if (!valid || !user) {
                    // Counted only for an existing account: tracking a nonexistent address would
                    // make the lock an enumeration oracle.
                    if (user) {
                        const { accountLocked } = await recordSignInFailure(user.id, source, now);
                        emitAccountLock(fastify, user.id, accountLocked);
                    }
                    recordLoginFailure();
                    return reply.status(401).send({ error: "Invalid credentials" });
                }

                // The locked_at check comes AFTER the password is validated — we do not leak the
                // fact of a lock to unauthenticated callers (they get the same 401 for a wrong
                // password as for a nonexistent user).
                if (user.locked_at !== null) {
                    recordLoginFailure();
                    return reply.status(403).send({ error: "account_locked" });
                }

                await clearSignInFailures(user.id, source);

                const expiresAt = await issueSession(reply, user.id, request);
                recordLoginSuccess();
                // Seam 4: the core reports **every** successful sign-in. Whether the device is
                // new, and whether a mail goes out, is the subscriber's decision — open-core
                // does not know those tables.
                fastify.emitSecurityEvent({
                    type: "login",
                    userId: user.id,
                    userAgent: request.headers["user-agent"] ?? null,
                    ip: request.ip,
                });
                return reply.send({
                    ok: true,
                    expires_at: expiresAt,
                    user_id: user.id,
                    encrypted_vault_key: bufToB64(user.encrypted_vault_key) ?? "",
                    vault_key_nonce: bufToB64(user.vault_key_nonce) ?? "",
                });
            } catch (err) {
                if (err instanceof Argon2BacklogError) {
                    return reply.status(503).send({ error: "service_unavailable" });
                }
                throw err;
            }
        },
    );

    fastify.post(
        "/auth/change-password",
        {
            ...credentialRoute,
            preParsing: [fastify.authenticateBeforeBody],
            preHandler: [userMutRl],
            config: { rateLimit: ipRateLimit(RL_SENSITIVE_MAX, RL_WINDOW) },
        },
        async (request, reply) => {
            const userId = requireUserId(request);
            const data = parseBody(ChangePasswordSchema, request, reply);
            if (!data) return;

            const {
                current_auth_key,
                new_auth_key,
                new_kdf_salt,
                new_kdf_params,
                new_encrypted_vault_key,
                new_vault_key_nonce,
            } = data;

            // Do not allow the KDF to be weakened during change-password (the production floor).
            try {
                assertKdfParamsFloor(new_kdf_params);
            } catch {
                return reply.status(400).send({ error: "weak_kdf_params" });
            }

            try {
                const { ok, user } = await verifyUserAuthKey(userId, current_auth_key);
                if (!user) return reply.status(401).send({ error: "User not found" });
                if (!ok) {
                    const { accountLocked } = await recordSignInFailure(
                        userId,
                        rateLimitKey(request),
                        nowSec(),
                    );
                    emitAccountLock(fastify, userId, accountLocked);
                    return reply.status(401).send({ error: "Invalid current password" });
                }

                const newAuthKeyHash = await hashAuthKey(new_auth_key);

                await db.transaction(async (tx) => {
                    // Only the auth credentials and the re-wrapped Vault Key change — the Item Keys are untouched.
                    await tx
                        .update(users)
                        .set({
                            auth_key_hash: newAuthKeyHash,
                            kdf_salt: requireB64ToBuf(new_kdf_salt),
                            kdf_params: JSON.stringify(new_kdf_params),
                            encrypted_vault_key: requireB64ToBuf(new_encrypted_vault_key),
                            vault_key_nonce: requireB64ToBuf(new_vault_key_nonce),
                        })
                        .where(eq(users.id, userId));

                    // Rotating the credentials invalidates EVERY existing session (including
                    // any stolen on other devices). A fresh session for the current request is issued
                    // after the commit.
                    await tx.delete(sessions).where(eq(sessions.user_id, userId));
                });

                await clearSignInFailures(userId, rateLimitKey(request));

                // A new session for the current device (token rotation after a password
                // change).
                const expiresAt = await issueSession(reply, userId, request);
                // Seam 4: a password change is reported **every time** and cannot be turned
                // off — it is the strongest signal of an account takeover.
                fastify.emitSecurityEvent({
                    type: "password_changed",
                    userId,
                    userAgent: request.headers["user-agent"] ?? null,
                    ip: request.ip,
                });
                return reply.send({ success: true, expires_at: expiresAt });
            } catch (err) {
                if (err instanceof Argon2BacklogError) {
                    return reply.status(503).send({ error: "service_unavailable" });
                }
                throw err;
            }
        },
    );

    fastify.get("/auth/me", authRead, async (request, reply) => {
        const userId = requireUserId(request);
        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user) {
            return reply.status(401).send({ error: "User not found" });
        }

        const saltBase64 = bufToB64(user.kdf_salt) ?? "";
        const params = JSON.parse(user.kdf_params) as KdfParams;

        return reply.send({
            email: user.email,
            kdf_salt: saltBase64,
            kdf_params: params,
            encrypted_vault_key: bufToB64(user.encrypted_vault_key) ?? "",
            vault_key_nonce: bufToB64(user.vault_key_nonce) ?? "",
        });
    });

    fastify.post(
        "/auth/logout",
        { bodyLimit: AUTH_BODY_LIMIT, config: { rateLimit: ipRateLimit(RL_LOGIN_MAX, RL_WINDOW) } },
        async (request, reply) => {
            const token = request.cookies[SESSION_COOKIE];
            if (token) {
                await db
                    .delete(sessions)
                    .where(eq(sessions.session_token, hashSessionToken(token)));
                clearSessionCookie(reply);
            }
            return reply.send({ success: true });
        },
    );

    fastify.get("/auth/sessions", authRead, async (request, reply) => {
        const userId = requireUserId(request);
        const currentToken = request.cookies[SESSION_COOKIE];

        const userSessions = await db
            .select({
                id: sessions.id,
                expires_at: sessions.expires_at,
                created_at: sessions.created_at,
                last_used_at: sessions.last_used_at,
                user_agent: sessions.user_agent,
                ip_address: sessions.ip_address,
                is_current: eq(
                    sessions.session_token,
                    currentToken ? hashSessionToken(currentToken) : "",
                ),
            })
            .from(sessions)
            .where(eq(sessions.user_id, userId))
            .orderBy(sessions.last_used_at);

        return reply.send({ sessions: userSessions });
    });

    fastify.delete<{ Params: { id: string } }>(
        "/auth/sessions/:id",
        authMut,
        async (request, reply) => {
            const userId = requireUserId(request);
            const sessionId = request.params.id;

            // Deleting the current session through this endpoint is not allowed (use /auth/logout)
            const token = request.cookies[SESSION_COOKIE];
            if (token) {
                const current = await db
                    .select({ id: sessions.id })
                    .from(sessions)
                    .where(eq(sessions.session_token, hashSessionToken(token)))
                    .limit(1);

                if (current[0]?.id === sessionId) {
                    return reply
                        .status(400)
                        .send({ error: "Cannot delete current session. Use logout." });
                }
            }

            const result = await db
                .delete(sessions)
                .where(and(eq(sessions.id, sessionId), eq(sessions.user_id, userId)))
                .returning({ id: sessions.id });

            if (result.length === 0) {
                return reply.status(404).send({ error: "Session not found" });
            }

            return reply.send({ success: true });
        },
    );

    const DeleteAccountSchema = z.object({
        auth_key: z
            .string()
            .regex(/^[A-Za-z0-9+/=]+$/)
            .length(44),
    });

    fastify.delete(
        "/auth/account",
        {
            ...credentialRoute,
            preParsing: [fastify.authenticateBeforeBody],
            preHandler: [userMutRl],
            config: { rateLimit: ipRateLimit(RL_SENSITIVE_MAX, RL_WINDOW) },
        },
        async (request, reply) => {
            const userId = requireUserId(request);
            // Zod; the minimum response duration comes from the route's floor hooks.
            const parsed = DeleteAccountSchema.safeParse(request.body);
            if (!parsed.success) {
                return reply.status(400).send({ error: "auth_key required" });
            }

            try {
                const { ok, user } = await verifyUserAuthKey(userId, parsed.data.auth_key);
                if (!user) return reply.status(404).send({ error: "User not found" });
                if (!ok) {
                    const { accountLocked } = await recordSignInFailure(
                        userId,
                        rateLimitKey(request),
                        nowSec(),
                    );
                    emitAccountLock(fastify, userId, accountLocked);
                    return reply.status(401).send({ error: "Invalid credentials" });
                }

                // The address is read **before** the deletion and travels inside the event itself:
                // after `purgeUserData` the `users` row is gone, so a subscriber would have nowhere
                // to look up who to notify.
                const deletedEmail = user.email;
                await db.transaction(async (tx) => {
                    await purgeUserData(tx, userId);
                });
                clearSessionCookie(reply);
                // Emitted only after the commit — so a deletion that did not go through is
                // never announced.
                fastify.emitSecurityEvent({
                    type: "account_deleted",
                    userId,
                    email: deletedEmail,
                });
                return reply.send({ success: true });
            } catch (err) {
                if (err instanceof Argon2BacklogError) {
                    return reply.status(503).send({ error: "service_unavailable" });
                }
                throw err;
            }
        },
    );
};

export default authRoutes;
