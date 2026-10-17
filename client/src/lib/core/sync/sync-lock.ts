/**
 * Cross-tab sync coordination — Web Lock shared by scheduler drain and foreground push.
 * Same-tab reentrancy: nested withSyncLock (pushPendingMutations inside syncNow) runs inline.
 */
export const SYNC_LOCK_NAME = "zknotes-sync";

/** Depth of locks held by this JS realm (tab). Nested acquires must not re-request Web Lock. */
let heldDepth = 0;

export function isSyncLockHeld(): boolean {
    return heldDepth > 0;
}

/**
 * Marks a rejection that came out of `fn` itself, as opposed to one from the Locks API.
 * `navigator.locks.request` rejects with the callback's error too, and the single-tab fallback
 * below used to treat that as "Locks unavailable" and run `fn` a SECOND time, outside the
 * cross-tab lock (a failed restore phase-5 pull re-ran unlocked; a drain that threw re-ran while
 * another tab may have been draining). Only a genuine Locks API failure may fall back.
 */
class SyncLockFnError {
    constructor(readonly cause: unknown) {}
}

async function runHeld(fn: () => Promise<void>): Promise<void> {
    heldDepth++;
    try {
        await fn();
    } catch (e) {
        throw new SyncLockFnError(e);
    } finally {
        heldDepth--;
    }
}

function rethrowUnwrapped(e: unknown): never {
    throw e instanceof SyncLockFnError ? e.cause : e;
}

/**
 * Run `fn` while holding the origin-wide sync lock.
 * - `ifAvailable: true` — skip if another tab holds the lock (background interval / focus).
 * - default — wait until the lock is free (foreground push must not race another tab's batch).
 * Returns whether `fn` actually ran (false only when ifAvailable and lock was busy).
 * A rejection from `fn` propagates unchanged; `fn` never runs twice.
 */
export async function withSyncLock(
    fn: () => Promise<void>,
    opts: { ifAvailable?: boolean } = {},
): Promise<boolean> {
    if (heldDepth > 0) {
        await fn();
        return true;
    }

    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks?.request) {
        await runHeld(fn).catch(rethrowUnwrapped);
        return true;
    }

    let ran = false;
    try {
        await locks.request(
            SYNC_LOCK_NAME,
            { ifAvailable: opts.ifAvailable === true },
            async (lock) => {
                if (!lock) return;
                ran = true;
                await runHeld(fn);
            },
        );
        return ran;
    } catch (e) {
        if (e instanceof SyncLockFnError) throw e.cause;
        // Locks API failure (not a failure of fn) → single-tab fallback
        await runHeld(fn).catch(rethrowUnwrapped);
        return true;
    }
}
