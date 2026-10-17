// Argon2 hashing of the Auth Key — the ONLY place that reads the ARGON2_* env parameters.
// Before this: register read the environment while change-password hardcoded {65536,3,4}, so a
// change to the env configuration diverged silently.
//
// withArgon2Slot: a concurrency cap — every hash/verify is 64 MiB × p=4;
// without a limit, N parallel sign-ins → N×64 MiB of RAM.
import { hash, verify } from "@node-rs/argon2";

const ARGON2_MEMORY_COST = Number(process.env.ARGON2_MEMORY_COST ?? 65536);
const ARGON2_TIME_COST = Number(process.env.ARGON2_TIME_COST ?? 3);
const ARGON2_PARALLELISM = Number(process.env.ARGON2_PARALLELISM ?? 4);
/** The max Argon2 operations at once (hash + verify). Default 4. */
const ARGON2_MAX_CONCURRENT = Math.max(1, Number(process.env.ARGON2_MAX_CONCURRENT ?? 4));
/** Cap on waiters behind the active slots. Further callers are rejected instead of growing unbounded. */
const ARGON2_MAX_WAITERS = Math.max(0, Number(process.env.ARGON2_MAX_WAITERS ?? 32));

/** Thrown when the Argon2 waiter queue is already full — callers should answer HTTP 503. */
export class Argon2BacklogError extends Error {
    readonly statusCode = 503 as const;
    constructor() {
        super("argon2_backlog");
        this.name = "Argon2BacklogError";
    }
}

/**
 * The Argon2 cost parameters — the only place that reads the ARGON2_* env. An extension that hashes
 * passwords of its own shares them, so the env configuration never diverges between the two.
 */
export const ARGON2_OPTIONS = {
    memoryCost: ARGON2_MEMORY_COST,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
} as const;

let argon2Active = 0;
const argon2Waiters: Array<() => void> = [];

/**
 * A semaphore around Argon2 — it prevents a memory/CPU spike when many IPs hit login/register at
 * once. Waiters are FIFO up to ARGON2_MAX_WAITERS; past that the caller is rejected so the queue
 * cannot grow without bound (the rate limit is the inflow bound, this is the RAM bound).
 */
export async function withArgon2Slot<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
        if (argon2Active < ARGON2_MAX_CONCURRENT) {
            argon2Active++;
            resolve();
        } else if (argon2Waiters.length >= ARGON2_MAX_WAITERS) {
            reject(new Argon2BacklogError());
        } else {
            argon2Waiters.push(() => {
                argon2Active++;
                resolve();
            });
        }
    });
    try {
        return await fn();
    } finally {
        argon2Active--;
        const next = argon2Waiters.shift();
        if (next) next();
    }
}

/** Test/observability: the current number of active Argon2 slots. */
export function getArgon2ActiveCount(): number {
    return argon2Active;
}

export function getArgon2MaxConcurrent(): number {
    return ARGON2_MAX_CONCURRENT;
}

export function getArgon2MaxWaiters(): number {
    return ARGON2_MAX_WAITERS;
}

/** Test/observability: queued waiters that have not yet acquired a slot. */
export function getArgon2WaiterCount(): number {
    return argon2Waiters.length;
}

/**
 * Hashes the client's Auth Key for storage in users.auth_key_hash.
 * Verifying existing hashes does not depend on these parameters (an encoded hash carries its own
 * cost parameters), so changing the env values is safe.
 */
export function hashAuthKey(authKey: string): Promise<string> {
    return withArgon2Slot(() => hash(authKey, ARGON2_OPTIONS));
}

/** Verify inside the same concurrency slot as hash. */
export function verifyAuthKey(hashEncoded: string, authKey: string): Promise<boolean> {
    return withArgon2Slot(() => verify(hashEncoded, authKey));
}
