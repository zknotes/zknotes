import { createHash } from "node:crypto";
import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "../db";
import { items, shareFailures, shareLinks, users } from "../db/schema";
import { minAuthResponseMs } from "../lib/auth-floor";
import { nowSec } from "../lib/time";
import { verifyAuthKey } from "./auth-service";
import { type BackoffPolicy, backoffAfterFailure, policyFromEnv } from "./login-throttle";

type ShareRow = typeof shareLinks.$inferSelect;
type GateDb = Pick<typeof db, "select" | "update" | "insert" | "delete">;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long after a burn view the recipient may still download attachments (seconds). */
export const SHARE_BURN_DOWNLOAD_GRACE_SEC = Number(
    process.env.SHARE_BURN_DOWNLOAD_GRACE_SEC ?? 900,
);

/**
 * The share-password lockout follows the sign-in one (login-throttle.ts): two counters, one
 * formula.
 *  - per share AND source (`share_failures`; the source is an IPv4 address or an IPv6 /64, the same
 *    subject the rate limit uses): 5 failures, then 30 s doubling up to 15 min, inside a one-hour
 *    window. The lock that stops a guessing run applies to its source only — one recipient guessing
 *    (or a stranger who has the link) cannot lock the link for everyone the owner sent it to.
 *  - per share (`share_links.failed_*`): the backstop for a run spread over many sources, with a
 *    threshold a single source cannot reach inside its own locks.
 * Both answer with the generic "unavailable" (anti-enumeration), and a wrong password counts only
 * when the caller also proved the fragment key.
 */
const SHARE_SOURCE_POLICY: BackoffPolicy = policyFromEnv("SHARE_PASSWORD_", {
    maxAttempts: 5,
    baseSeconds: 30,
    maxSeconds: 900,
    windowSeconds: 3600,
});
const SHARE_BACKSTOP_POLICY: BackoffPolicy = policyFromEnv("SHARE_PASSWORD_SHARE_", {
    maxAttempts: 100,
    baseSeconds: 900,
    maxSeconds: 3600,
    windowSeconds: 3600,
});

// ── The verified-key cache ─────────────────────────────────────────────────────
// A password-protected share used to run Argon2 on EVERY chunk request (120 a minute per IP against
// four Argon2 slots shared with sign-in), although the key had already passed on the view. Once a
// key is verified for a share, its hash is remembered for a while and the chunk path skips the
// verify. Only hashes live here — a stale or lost entry costs one more Argon2, never correctness —
// and the lock checks still run first.
const VERIFIED_KEY_TTL_MS = Number(process.env.SHARE_VERIFIED_KEY_TTL_SEC ?? 900) * 1000;
const VERIFIED_KEY_MAX = 5000;
const verifiedKeys = new Map<string, number>(); // id → expires at (ms)

function verifiedKeyId(shareId: string, shareAuthKey: string): string {
    return `${shareId}:${createHash("sha256").update(shareAuthKey).digest("hex")}`;
}

function rememberVerifiedKey(shareId: string, shareAuthKey: string): void {
    const id = verifiedKeyId(shareId, shareAuthKey);
    verifiedKeys.delete(id); // re-insert so the Map's order is recency
    verifiedKeys.set(id, Date.now() + VERIFIED_KEY_TTL_MS);
    while (verifiedKeys.size > VERIFIED_KEY_MAX) {
        const oldest = verifiedKeys.keys().next().value;
        if (oldest === undefined) break;
        verifiedKeys.delete(oldest);
    }
}

function isVerifiedKeyCached(shareId: string, shareAuthKey: string): boolean {
    const id = verifiedKeyId(shareId, shareAuthKey);
    const until = verifiedKeys.get(id);
    if (until === undefined) return false;
    if (until <= Date.now()) {
        verifiedKeys.delete(id);
        return false;
    }
    return true;
}

/** Test-only: forget every remembered key, so a test can observe the verify path again. */
export function __clearVerifiedShareKeysForTest(): void {
    verifiedKeys.clear();
}

/** Delete share-password runs that are neither locked nor inside their window any more (GC). */
export async function purgeStaleShareFailures(now: number): Promise<number> {
    const deleted = await db
        .delete(shareFailures)
        .where(
            and(
                lt(shareFailures.window_started_at, now - SHARE_SOURCE_POLICY.windowSeconds),
                or(isNull(shareFailures.locked_until), lte(shareFailures.locked_until, now)),
            ),
        )
        .returning({ share_id: shareFailures.share_id });
    return deleted.length;
}

async function isSourceLocked(
    tx: GateDb,
    shareId: string,
    source: string,
    now: number,
): Promise<boolean> {
    const [row] = await tx
        .select({ locked_until: shareFailures.locked_until })
        .from(shareFailures)
        .where(and(eq(shareFailures.share_id, shareId), eq(shareFailures.source, source)))
        .limit(1);
    return row?.locked_until != null && row.locked_until > now;
}

/** One failure from `source`: the per-source run, then the per-share backstop — each one statement. */
async function recordShareFailure(
    tx: GateDb,
    shareId: string,
    source: string,
    now: number,
): Promise<void> {
    const perSource = backoffAfterFailure(
        {
            attempts: shareFailures.failed_attempts,
            windowStart: shareFailures.window_started_at,
            lockedUntil: shareFailures.locked_until,
        },
        now,
        SHARE_SOURCE_POLICY,
    );
    await tx
        .insert(shareFailures)
        .values({
            share_id: shareId,
            source,
            failed_attempts: 1,
            window_started_at: now,
            locked_until:
                SHARE_SOURCE_POLICY.maxAttempts <= 1 ? now + SHARE_SOURCE_POLICY.baseSeconds : null,
        })
        .onConflictDoUpdate({
            target: [shareFailures.share_id, shareFailures.source],
            set: {
                failed_attempts: perSource.attempts,
                window_started_at: perSource.windowStart,
                locked_until: perSource.lockedUntil,
            },
            setWhere: or(isNull(shareFailures.locked_until), lte(shareFailures.locked_until, now)),
        });

    // The backstop: one atomic UPDATE computed from the row as it is now, so parallel guesses on
    // the unlocked chunk path cannot all read 0 and write 1.
    const backstop = backoffAfterFailure(
        {
            attempts: shareLinks.failed_attempts,
            windowStart: shareLinks.failed_window_started_at,
            lockedUntil: shareLinks.locked_until,
        },
        now,
        SHARE_BACKSTOP_POLICY,
    );
    await tx
        .update(shareLinks)
        .set({
            failed_attempts: backstop.attempts,
            failed_window_started_at: backstop.windowStart,
            locked_until: backstop.lockedUntil,
            updated_at: now,
        })
        .where(
            and(
                eq(shareLinks.id, shareId),
                or(isNull(shareLinks.locked_until), lte(shareLinks.locked_until, now)),
            ),
        );
}

/** The SHA-256 hex of the view_proof (standard base64 on the wire) — not Argon2 (the proof is already 32B of entropy). */
export function hashViewProof(viewProofB64: string): string {
    return createHash("sha256").update(Buffer.from(viewProofB64, "base64")).digest("hex");
}

/**
 * Does the caller hold the fragment key? The proof is HKDF(linkKey), and the server stores only its
 * hash — so this says "you have the `#k=` part of the link" without the link key ever going on the
 * wire. It lives here rather than in the route because BOTH unauthenticated surfaces need it: the
 * view and the chunk fetch.
 */
export function viewProofMatches(storedHash: string | null, supplied: string | undefined): boolean {
    // A share with no stored hash predates the view proof and must not open on the share id alone.
    if (!storedHash) return false;
    if (!supplied) return false;
    // `Buffer.from(x, "base64")` never throws — garbage simply hashes to something else.
    return hashViewProof(supplied) === storedHash;
}

/** Every "unavailable" response shares the same minimum response time (anti-enumeration timing). */
export async function floorShareResponse(started: number): Promise<void> {
    const floor = minAuthResponseMs();
    const elapsed = Date.now() - started;
    if (elapsed < floor) await delay(floor - elapsed);
}

export function isShareActive(row: ShareRow, now: number): boolean {
    if (row.revoked_at != null) return false;
    if (row.expires_at != null && row.expires_at < now) return false;
    return true;
}

/**
 * An active link serves chunks; so does a burned one until `burn_grace_until`, so the view that
 * consumed it does not cut its own download short. Revoke and the expiry sweep clear that deadline,
 * which is why it is a stored column rather than inferred from the timestamps.
 */
export function isShareChunkAccessible(row: ShareRow, now: number): boolean {
    // Expiry always wins: a burned link must not keep serving attachments after `expires_at`
    // just because `burn_grace_until` is still in the future (GC may not have run yet).
    if (row.expires_at != null && row.expires_at < now) return false;
    if (isShareActive(row, now)) return true;
    return row.burn_grace_until != null && now <= row.burn_grace_until;
}

export type ShareGateOk = {
    ok: true;
    share: ShareRow;
    sourceDeleted: boolean;
};

export type ShareGateFail = { ok: false };

export async function verifyShareGate(
    tx: GateDb,
    shareId: string,
    opts: {
        mode: "meta" | "view" | "chunk";
        shareAuthKey?: string;
        /**
         * Proof of the fragment key. Required for "chunk"; "view" checks it itself before opening
         * the burn/view-count transaction. "meta" never sees one — its entire job is to tell a
         * caller with nothing but the link whether a password is needed.
         */
        viewProof?: string;
        /**
         * Where the request comes from (`rateLimitKey`): the per-source lockout counts under it.
         * Required for "view" and "chunk" — without a source a wrong password is not counted at
         * all, so a route must never omit it.
         */
        source?: string;
        started?: number;
    },
): Promise<ShareGateOk | ShareGateFail> {
    const started = opts.started ?? Date.now();
    const finishFail = async (): Promise<ShareGateFail> => {
        await floorShareResponse(started);
        return { ok: false };
    };

    const [row] = await tx
        .select({
            share: shareLinks,
            item_deleted: items.deleted_at,
            account_locked: users.locked_at,
        })
        .from(shareLinks)
        .leftJoin(items, eq(shareLinks.source_item_id, items.id))
        .innerJoin(users, eq(shareLinks.user_id, users.id))
        .where(eq(shareLinks.id, shareId))
        .limit(1);

    if (!row?.share) return finishFail();

    // A share without a stored hash predates the view proof; a NULL hash must never open the share
    // on the id alone.
    if (row.share.view_proof_hash == null) return finishFail();

    const now = nowSec();
    const accessible =
        opts.mode === "chunk"
            ? isShareChunkAccessible(row.share, now)
            : isShareActive(row.share, now);

    if (!accessible || row.item_deleted != null || row.account_locked != null) {
        return finishFail();
    }

    // Chunks need the fragment key, the same as a view — the share id alone travels in the URL path
    // and buys nothing. Checked before the password path so a caller without it never reaches the
    // failure counter below.
    if (opts.mode === "chunk" && !viewProofMatches(row.share.view_proof_hash, opts.viewProof)) {
        return finishFail();
    }
    // The lockout counter hangs off a POSITIVELY proven fragment key: a wrong password is only
    // counted when the caller also holds it, so anyone who merely saw the share id cannot walk the
    // backoff.
    const proofVerified = viewProofMatches(row.share.view_proof_hash, opts.viewProof);

    // "meta" (GET /shares/:id) exists precisely to tell the client WHETHER a password is needed — it
    // never receives one. The password gate applies only to "view" (a real attempt) and "chunk".
    if (opts.mode !== "meta" && row.share.share_auth_key_hash) {
        // Lockout — the share-wide backstop, then this source's own run: the same "unavailable" as
        // a wrong password (anti-enumeration), and a correct password is NOT accepted during a
        // lock, or the lock would confirm the guess.
        if (row.share.locked_until != null && row.share.locked_until > now) {
            return finishFail();
        }
        if (opts.source && (await isSourceLocked(tx, shareId, opts.source, now))) {
            return finishFail();
        }
        if (!opts.shareAuthKey) return finishFail();

        // The chunk path trusts a key this process verified recently (see the cache above); the
        // view always verifies, so a real attempt always pays the Argon2.
        const cached = opts.mode === "chunk" && isVerifiedKeyCached(shareId, opts.shareAuthKey);
        const ok =
            cached || (await verifyAuthKey(row.share.share_auth_key_hash, opts.shareAuthKey));
        if (!ok) {
            // Only a proven fragment key may move the counters — otherwise anyone holding just the
            // share id could walk the backoff.
            if (proofVerified && opts.source && (opts.mode === "view" || opts.mode === "chunk")) {
                await recordShareFailure(tx, shareId, opts.source, now);
            }
            return finishFail();
        }
        rememberVerifiedKey(shareId, opts.shareAuthKey);

        // Success: forget this source's run and the share-wide count. Another source's lock stays —
        // the recipient the link was meant for must not release whoever was guessing.
        if (opts.source) {
            await tx
                .delete(shareFailures)
                .where(
                    and(eq(shareFailures.share_id, shareId), eq(shareFailures.source, opts.source)),
                );
        }
        if (
            (row.share.failed_attempts ?? 0) !== 0 ||
            row.share.locked_until != null ||
            row.share.failed_window_started_at != null
        ) {
            await tx
                .update(shareLinks)
                .set({
                    failed_attempts: 0,
                    locked_until: null,
                    failed_window_started_at: null,
                    updated_at: now,
                })
                .where(eq(shareLinks.id, shareId));
        }
    }

    return { ok: true, share: row.share, sourceDeleted: row.item_deleted != null };
}
