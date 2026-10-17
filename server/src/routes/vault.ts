// `POST /vault` — creating the vault.
//
// The core's version is **the first registration on a self-host**: while there is not a single user in
// the database, whoever reaches the instance may open a vault. After the first user the route is
// closed, unless the owner opens registration explicitly (`SELF_HOST_REGISTRATION_OPEN=true`).
//
// The predicate itself lives in `entitlements.ts::selfHostRegistrationStatus`, shared with
// `GET /auth/registration-status` so the two can never disagree.
//
// A deployment that extends the core may **take this route over** (seam 3), with preconditions of
// its own. That is why there are neither Terms nor a plan here — a self-host has neither, and an
// extension settles both on its own side.
import { VaultCreateSchema } from "@zknotes/shared";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { OPEN_REGISTRATION } from "../entitlements";
import { AUTH_BODY_LIMIT, authResponseFloor } from "../lib/auth-floor";
import { ipRateLimit } from "../lib/rate-limit";
import { Argon2BacklogError } from "../services/auth-service";
import { createVaultUser } from "../services/vault-service";

// Duplicated from auth.ts (do not import the auth routes module from here).
const RL_WINDOW = process.env.AUTH_RATELIMIT_WINDOW ?? "15 minutes";
const RL_REGISTER_MAX = Number(process.env.AUTH_REGISTER_RATELIMIT_MAX ?? 5);
/** Transaction-level advisory lock that serialises vault creation (migrate.ts uses 872_015_001). */
const VAULT_CREATE_LOCK_KEY = 872_015_002;

const postgresErrorCode = (err: unknown): string | undefined => {
    const direct = (err as { code?: string } | null)?.code;
    if (typeof direct === "string") return direct;
    const nested = (err as { cause?: { code?: string } } | null)?.cause?.code;
    return typeof nested === "string" ? nested : undefined;
};

const vaultRoutes: FastifyPluginAsync = async (fastify) => {
    // Seam 3: if an extension has already registered its own version, the core skips its own.
    if (fastify.hasRoute({ method: "POST", url: "/vault" })) return;

    fastify.post(
        "/vault",
        {
            // Registering an address that already exists answers the same 201 as a new one; the
            // floor keeps the timing from telling them apart.
            ...authResponseFloor,
            bodyLimit: AUTH_BODY_LIMIT,
            config: { rateLimit: ipRateLimit(RL_REGISTER_MAX, RL_WINDOW) },
        },
        async (request, reply) => {
            const parsed = VaultCreateSchema.safeParse(request.body);
            if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

            // Same predicate `GET /auth/registration-status` publishes — asked of the provider (seam 2),
            // so the two cannot drift: if the UI says a vault can be opened, this route allows it.
            const status =
                (await fastify.entitlements.registrationStatus?.(db)) ?? OPEN_REGISTRATION;
            if (!status.open) {
                return reply.status(403).send({ error: "registration_closed" });
            }

            try {
                const userId = await db.transaction(async (tx) => {
                    // The check above runs before the transaction, so two requests that both saw an
                    // instance with no user could both create one. Vault creation is serialised
                    // here and the question asked again: the second request now sees the first
                    // vault (READ COMMITTED reads what committed before the lock was granted).
                    await tx.execute(sql`SELECT pg_advisory_xact_lock(${VAULT_CREATE_LOCK_KEY})`);
                    const inside =
                        (await fastify.entitlements.registrationStatus?.(tx)) ?? OPEN_REGISTRATION;
                    if (!inside.open) return null;
                    return createVaultUser(tx, parsed.data, fastify.entitlements.quotaForNewUser());
                });
                if (userId === null) {
                    return reply.status(403).send({ error: "registration_closed" });
                }
                fastify.emitUserRegistered({ userId });
                return reply.status(201).send({ created: true });
            } catch (err) {
                if (err instanceof Error && err.message === "weak_kdf_params") {
                    return reply.status(400).send({ error: "weak_kdf_params" });
                }
                if (err instanceof Argon2BacklogError) {
                    return reply.status(503).send({ error: "service_unavailable" });
                }
                // Unique email (users_email_lower_idx / users_email_idx): same 201 as success so a
                // duplicate cannot be distinguished from a new vault. Do not emit registration.
                if (postgresErrorCode(err) === "23505") {
                    return reply.status(201).send({ created: true });
                }
                throw err;
            }
        },
    );
};

export default vaultRoutes;
