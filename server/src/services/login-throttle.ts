// Sign-in throttling: how failed credential checks turn into temporary locks.
//
// Two counters, one formula:
//   - per account AND source (`login_failures`): the lock that actually stops a guessing run. It is
//     scoped to the source — an IPv4 address or an IPv6 /64 — so someone who knows an address can
//     lock out only themselves, never the owner signing in from elsewhere;
//   - per account (`users.failed_*`): a backstop with a much higher threshold, for a run spread over
//     many sources. It is the only lock that can keep the owner out, and reaching it takes many
//     sources at once.
// Both answer exactly like a wrong password (401, the same body): a distinct "locked" reply would
// tell an attacker the account exists, and a correct password accepted during a lock would turn the
// lock into an oracle that confirms the guess.
import { and, eq, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../db";
import { loginFailures, users } from "../db/schema";

export interface BackoffPolicy {
    /** Failures inside one window that set the first lock. */
    maxAttempts: number;
    /** The first lock; each further failure in the same window doubles it. */
    baseSeconds: number;
    maxSeconds: number;
    /**
     * How long a run of failures stays "the same run". Attempts made while locked do not count, so
     * a monotonic counter would measure lock events — which the attacker chooses — and one request
     * per expiring lock would hold the cap for good. When the window lapses the next failure starts
     * a fresh run below the threshold, so the window also bounds how fast one run can go.
     */
    windowSeconds: number;
}

function policyFromEnv(prefix: string, defaults: BackoffPolicy): BackoffPolicy {
    const read = (name: string, fallback: number) => Number(process.env[prefix + name] ?? fallback);
    return {
        maxAttempts: read("MAX_ATTEMPTS", defaults.maxAttempts),
        baseSeconds: read("LOCKOUT_BASE_SECONDS", defaults.baseSeconds),
        maxSeconds: read("LOCKOUT_MAX_SECONDS", defaults.maxSeconds),
        windowSeconds: read("FAIL_WINDOW_SECONDS", defaults.windowSeconds),
    };
}

/**
 * Per account and source: 5 failures, then 30 s doubling up to 15 min, inside a one-hour window. In
 * an hour one source gets 5 failures, one after each of the 30 s … 480 s locks, and then one per
 * 15 min — about thirteen. (With a window as short as the cap a fresh run of five would start every
 * quarter of an hour, nearly three times as many.)
 */
export const SOURCE_POLICY = policyFromEnv("USER_LOGIN_", {
    maxAttempts: 5,
    baseSeconds: 30,
    maxSeconds: 900,
    windowSeconds: 3600,
});

/**
 * Per account, across every source. At about thirteen failures an hour per source, 100 an hour takes
 * eight or more sources working together. The window equals the cap, so a lock at the cap uses up
 * the window that produced it and holding the account takes another hundred failures.
 */
export const ACCOUNT_POLICY = policyFromEnv("USER_LOGIN_ACCOUNT_", {
    maxAttempts: 100,
    baseSeconds: 900,
    maxSeconds: 3600,
    windowSeconds: 3600,
});

interface BackoffColumns {
    attempts: AnyPgColumn;
    windowStart: AnyPgColumn;
    lockedUntil: AnyPgColumn;
}

/**
 * The counter, the window and the lock after one more failure, computed in SQL from the row as it is
 * now — never from a snapshot read before the Argon2 check, or parallel failures would all write the
 * same count and never lock. `LEAST(base * 2^(over), max)` — the same formula as the share gate.
 */
function backoffAfterFailure(
    cols: BackoffColumns,
    now: number,
    p: BackoffPolicy,
): { attempts: SQL; windowStart: SQL; lockedUntil: SQL } {
    const inWindow = sql`${cols.windowStart} IS NOT NULL
        AND ${now} - ${cols.windowStart} <= ${p.windowSeconds}`;
    const attempts = sql`CASE WHEN ${inWindow} THEN ${cols.attempts} + 1 ELSE 1 END`;
    return {
        attempts,
        windowStart: sql`CASE WHEN ${inWindow} THEN ${cols.windowStart} ELSE ${now} END`,
        lockedUntil: sql`CASE
            WHEN (${attempts}) >= ${p.maxAttempts}
            THEN ${now} + LEAST(
                ${p.baseSeconds}::numeric * POWER(2, GREATEST(0, (${attempts}) - ${p.maxAttempts})),
                ${p.maxSeconds}
            )::bigint
            WHEN (${attempts}) = 1 THEN NULL
            ELSE ${cols.lockedUntil}
        END`,
    };
}

const isLocked = (lockedUntil: number | null | undefined, now: number) =>
    lockedUntil != null && lockedUntil > now;

/** Whether the account, or this source's run against it, is inside a lock. */
export async function isSignInLocked(
    user: { id: string; locked_until: number | null },
    source: string,
    now: number,
): Promise<boolean> {
    if (isLocked(user.locked_until, now)) return true;
    const [row] = await db
        .select({ locked_until: loginFailures.locked_until })
        .from(loginFailures)
        .where(and(eq(loginFailures.user_id, user.id), eq(loginFailures.source, source)))
        .limit(1);
    return isLocked(row?.locked_until, now);
}

/**
 * Record one failed credential check from `source`. Each counter is one statement that skips a row
 * already inside a lock — the same as the sequential path, where a locked request returns before it
 * counts — so at most one caller ever sees a counter land on its threshold.
 *
 * Returns whether this failure locked the whole account: that transition, and only that one, is the
 * `account_locked` security event. A per-source lock is not announced — it says nothing about the
 * owner, and a mail per locked source would let anyone with a few addresses flood the inbox.
 */
export async function recordSignInFailure(
    userId: string,
    source: string,
    now: number,
): Promise<{ accountLocked: boolean }> {
    const perSource = backoffAfterFailure(
        {
            attempts: loginFailures.failed_attempts,
            windowStart: loginFailures.window_started_at,
            lockedUntil: loginFailures.locked_until,
        },
        now,
        SOURCE_POLICY,
    );
    await db
        .insert(loginFailures)
        .values({
            user_id: userId,
            source,
            failed_attempts: 1,
            window_started_at: now,
            locked_until: SOURCE_POLICY.maxAttempts <= 1 ? now + SOURCE_POLICY.baseSeconds : null,
        })
        .onConflictDoUpdate({
            target: [loginFailures.user_id, loginFailures.source],
            set: {
                failed_attempts: perSource.attempts,
                window_started_at: perSource.windowStart,
                locked_until: perSource.lockedUntil,
            },
            setWhere: or(isNull(loginFailures.locked_until), lte(loginFailures.locked_until, now)),
        });

    const account = backoffAfterFailure(
        {
            attempts: users.failed_attempts,
            windowStart: users.failed_window_started_at,
            lockedUntil: users.locked_until,
        },
        now,
        ACCOUNT_POLICY,
    );
    const [row] = await db
        .update(users)
        .set({
            failed_attempts: account.attempts,
            failed_window_started_at: account.windowStart,
            locked_until: account.lockedUntil,
        })
        .where(
            and(eq(users.id, userId), or(isNull(users.locked_until), lte(users.locked_until, now))),
        )
        .returning({ failed_attempts: users.failed_attempts });
    // No row: the account was already locked (a racer crossed the threshold first) or is gone.
    return {
        accountLocked: row !== undefined && row.failed_attempts >= ACCOUNT_POLICY.maxAttempts,
    };
}

type Executor = Pick<typeof db, "update" | "delete">;

/**
 * Forget the failures behind a successful sign-in: this source's run and the account-wide count.
 * Another source's lock stays — the owner signing in must not release whoever was guessing.
 */
export async function clearSignInFailures(userId: string, source: string): Promise<void> {
    await db
        .delete(loginFailures)
        .where(and(eq(loginFailures.user_id, userId), eq(loginFailures.source, source)));
    await db
        .update(users)
        .set({ failed_attempts: 0, locked_until: null, failed_window_started_at: null })
        .where(eq(users.id, userId));
}

/** Clear every lock on an account, from every source — an operator's manual unlock. */
export async function clearAllSignInFailures(executor: Executor, userId: string): Promise<void> {
    await executor.delete(loginFailures).where(eq(loginFailures.user_id, userId));
    await executor
        .update(users)
        .set({ failed_attempts: 0, locked_until: null, failed_window_started_at: null })
        .where(eq(users.id, userId));
}

/** Delete runs that are neither locked nor inside their window any more (GC). */
export async function purgeStaleSignInFailures(now: number): Promise<number> {
    const deleted = await db
        .delete(loginFailures)
        .where(
            and(
                lt(loginFailures.window_started_at, now - SOURCE_POLICY.windowSeconds),
                or(isNull(loginFailures.locked_until), lte(loginFailures.locked_until, now)),
            ),
        )
        .returning({ user_id: loginFailures.user_id });
    return deleted.length;
}
