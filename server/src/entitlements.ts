// Seam 2 — the entitlements provider.
//
// The core knows nothing of plans, subscriptions or prices. All it can do is ask "what is this
// user allowed to do", and a provider answers. The open-core default is **permissive and driven by the
// environment**; an extended deployment replaces it with an implementation backed by its own plans.
//
// Why a holder rather than a plain value: the routes read the provider **at call time**, so an
// extension may replace it during registration, before any route has answered.
import { envPositiveNumber } from "./lib/env";
import { FILE_LIMITS } from "@zknotes/shared";
import { count } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { db } from "./db";
import { users } from "./db/schema";

export type EntitlementsDb = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What a user is allowed to do. Deliberately **without** a plan name in the decisions — the label is for display only (seam 5). */
export type Entitlements = {
    readonly maxActiveShares: number;
    readonly maxShareTtlSec: number;
    /** The plan's name, for display; `null` on a self-host — the UI row is then not rendered. */
    readonly planLabel: string | null;
    readonly isPaid: boolean;
};

/** The quota a freshly created user gets. Kept apart from `Entitlements` because it is written into the `users` row. */
export type NewUserQuota = {
    readonly storageQuota: number;
    readonly maxFileSize: number;
};

/** Whether a new account may be opened. `count`/`cap` are optional — the core only passes them through. */
export type RegistrationStatus = {
    readonly open: boolean;
    readonly count?: number;
    readonly cap?: number;
};

export type EntitlementsProvider = {
    readonly name: string;
    forUser(tx: EntitlementsDb, userId: string): Promise<Entitlements>;
    quotaForNewUser(): NewUserQuota;

    // ── The in-transaction part of the seam ───────────────────────────────────────────────────
    // A registration gate and a plan assignment are not notifications: they run **inside the
    // transaction**, which a fire-and-forget hook (seam 4) cannot express. Both are optional: without
    // them the core behaves as though registration were open and there were nothing to assign.

    /** Called both before the pending row is written (with `db`) and inside the transaction (with `tx`). */
    registrationStatus?(tx: EntitlementsDb): Promise<RegistrationStatus>;
    /** Immediately after the user is inserted, **in the same transaction** — it may write a plan. */
    onUserCreatedInTx?(tx: EntitlementsDb, userId: string, email: string): Promise<void>;
};

/** Fallback for a provider with no opinion on registration at all — then nothing is closed. */
export const OPEN_REGISTRATION: RegistrationStatus = { open: true };

/** `SELF_HOST_REGISTRATION_OPEN=true` keeps registration open past the first user. */
const registrationForcedOpen = (): boolean =>
    String(process.env.SELF_HOST_REGISTRATION_OPEN ?? "").toLowerCase() === "true";

/**
 * Self-host bootstrap: while the database holds no user, whoever reaches the instance may
 * open a vault; after the first one it is closed. Keys are still derived in the browser — this is
 * only the question of **whether** a `users` row may be created at all.
 *
 * This is the single place that predicate lives: `POST /vault` decides by it and
 * `GET /auth/registration-status` publishes the same thing, so the two cannot drift apart.
 *
 * The user count is deliberately **not** returned: the endpoint is public and a self-host has no
 * use for that number.
 */
export async function selfHostRegistrationStatus(tx: EntitlementsDb): Promise<RegistrationStatus> {
    if (registrationForcedOpen()) return { open: true };
    const [row] = await tx.select({ value: count() }).from(users);
    return { open: (row?.value ?? 0) === 0 };
}

// The permissive default (seam 2). The numbers are **plan-independent** and come from the
// environment: whoever hosts decides how much they give. The values are generous on purpose — a
// self-host is not throttled artificially.
const num = envPositiveNumber;

export const permissiveEntitlementsProvider: EntitlementsProvider = {
    name: "permissive-env",
    async forUser() {
        return {
            maxActiveShares: num("SELF_HOST_MAX_ACTIVE_SHARES", 10_000),
            maxShareTtlSec: num("SELF_HOST_MAX_SHARE_TTL_SEC", 365 * 24 * 60 * 60),
            // A self-host has no plan — the row carrying the plan name is not shown.
            planLabel: null,
            // There is no billing, so there is no "free" restriction either: everything there is, is allowed.
            isPaid: true,
        };
    },
    quotaForNewUser() {
        return {
            storageQuota: num("SELF_HOST_STORAGE_QUOTA", 100 * 1024 * 1024 * 1024),
            // A self-host has no plan, so there is no reason for an artificial per-file ceiling: what
            // binds is the disk — through `storageQuota` — and the wire format itself.
            // `MAX_FILE_SIZE_CAP` is that format's own ceiling (multipart, 12 GiB of plaintext),
            // and the Zod schema on POST /uploads refuses anything above it. A larger number here
            // could therefore never be honoured: it would only make a 413 report a limit that does
            // not exist, so the env override is clamped to the cap rather than trusted blindly.
            maxFileSize: Math.min(
                num("SELF_HOST_MAX_FILE_SIZE", FILE_LIMITS.MAX_FILE_SIZE_CAP),
                FILE_LIMITS.MAX_FILE_SIZE_CAP,
            ),
        };
    },
    registrationStatus: selfHostRegistrationStatus,
};

declare module "fastify" {
    interface FastifyInstance {
        readonly entitlements: EntitlementsProvider;
        setEntitlementsProvider(provider: EntitlementsProvider): void;
    }
}

export const entitlements = fp(
    async (fastify: FastifyInstance) => {
        let current: EntitlementsProvider = permissiveEntitlementsProvider;
        fastify.decorate("entitlements", {
            getter: () => current,
        });
        fastify.decorate("setEntitlementsProvider", (provider: EntitlementsProvider) => {
            current = provider;
        });
    },
    { name: "entitlements" },
);
