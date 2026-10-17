import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { db } from "../db";
import { items, shareLinks, users } from "../db/schema";
import { minAuthResponseMs } from "../lib/auth-floor";
import { nowSec } from "../lib/time";
import { verifyAuthKey } from "./auth-service";

type ShareRow = typeof shareLinks.$inferSelect;
type GateDb = Pick<typeof db, "select" | "update">;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long after a burn view the recipient may still download attachments (seconds). */
export const SHARE_BURN_DOWNLOAD_GRACE_SEC = Number(
    process.env.SHARE_BURN_DOWNLOAD_GRACE_SEC ?? 900,
);

// The per-share password lockout — the same progression as the user login.
const SHARE_PWD_MAX_ATTEMPTS = Number(process.env.SHARE_PASSWORD_MAX_ATTEMPTS ?? 5);
const SHARE_PWD_LOCKOUT_BASE_SECONDS = Number(
    process.env.SHARE_PASSWORD_LOCKOUT_BASE_SECONDS ?? 30,
);
const SHARE_PWD_LOCKOUT_MAX_SECONDS = Number(process.env.SHARE_PASSWORD_LOCKOUT_MAX_SECONDS ?? 900);
const SHARE_PWD_FAIL_WINDOW_SECONDS = Number(
    process.env.SHARE_PASSWORD_FAIL_WINDOW_SECONDS ?? SHARE_PWD_LOCKOUT_MAX_SECONDS,
);

/**
 * The failure count after this miss, and the window it belongs to.
 *
 * Failures only accumulate within `windowSeconds` of the first one. Attempts made while locked
 * return early without incrementing, so a monotonic counter measured lock events — which a holder
 * of the link chooses — and one request per expiring lock held a share shut for good.
 *
 * The production write is an atomic UPDATE CASE that must match this arithmetic (a read-modify-write
 * on the chunk path lost increments under parallel guesses).
 */
export function nextShareFailureCount(
    previous: { failed_attempts: number; failed_window_started_at: number | null },
    now: number,
    windowSeconds: number = SHARE_PWD_FAIL_WINDOW_SECONDS,
): { attempts: number; windowStartedAt: number } {
    const startedAt = previous.failed_window_started_at;
    const withinWindow = startedAt !== null && now - startedAt <= windowSeconds;
    if (!withinWindow) return { attempts: 1, windowStartedAt: now };
    return { attempts: previous.failed_attempts + 1, windowStartedAt: startedAt };
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
    try {
        return hashViewProof(supplied) === storedHash;
    } catch {
        return false;
    }
}

/**
 * Did the caller POSITIVELY prove the fragment key? The lockout counter hangs off this: a wrong
 * password is only counted when the caller also holds the fragment key, so anyone who merely saw
 * the share id cannot walk the backoff.
 */
export function viewProofVerified(
    storedHash: string | null,
    supplied: string | undefined,
): boolean {
    if (!storedHash || !supplied) return false;
    try {
        return hashViewProof(supplied) === storedHash;
    } catch {
        return false;
    }
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
    const proofVerified = viewProofVerified(row.share.view_proof_hash, opts.viewProof);

    // "meta" (GET /shares/:id) exists precisely to tell the client WHETHER a password is needed — it
    // never receives one. The password gate applies only to "view" (a real attempt) and "chunk".
    if (opts.mode !== "meta" && row.share.share_auth_key_hash) {
        // Lockout: the same "unavailable" as a wrong password (anti-enumeration).
        if (row.share.locked_until != null && row.share.locked_until > now) {
            return finishFail();
        }
        if (!opts.shareAuthKey) return finishFail();

        const ok = await verifyAuthKey(row.share.share_auth_key_hash, opts.shareAuthKey);
        if (!ok) {
            // Only a proven fragment key may move the counter — otherwise anyone holding just the
            // share id could walk the backoff. Arithmetic matches `nextShareFailureCount`; the
            // write is a single UPDATE so parallel guesses on the unlocked chunk path cannot all
            // read 0 and write 1.
            if (proofVerified && (opts.mode === "view" || opts.mode === "chunk")) {
                const withinWindow = sql`${shareLinks.failed_window_started_at} IS NOT NULL AND ${now} - ${shareLinks.failed_window_started_at} <= ${SHARE_PWD_FAIL_WINDOW_SECONDS}`;
                const newAttempts = sql`CASE WHEN ${withinWindow} THEN ${shareLinks.failed_attempts} + 1 ELSE 1 END`;
                await tx
                    .update(shareLinks)
                    .set({
                        failed_attempts: newAttempts,
                        failed_window_started_at: sql`CASE WHEN ${withinWindow} THEN ${shareLinks.failed_window_started_at} ELSE ${now} END`,
                        locked_until: sql`CASE
                            WHEN (${newAttempts}) >= ${SHARE_PWD_MAX_ATTEMPTS}
                            THEN ${now} + LEAST(
                                ${SHARE_PWD_LOCKOUT_BASE_SECONDS}::numeric * POWER(
                                    2,
                                    GREATEST(0, (${newAttempts}) - ${SHARE_PWD_MAX_ATTEMPTS})
                                ),
                                ${SHARE_PWD_LOCKOUT_MAX_SECONDS}
                            )::bigint
                            WHEN (${newAttempts}) = 1 THEN NULL
                            ELSE ${shareLinks.locked_until}
                        END`,
                        updated_at: now,
                    })
                    .where(eq(shareLinks.id, shareId));
            }
            return finishFail();
        }

        // Success: reset the counter.
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
