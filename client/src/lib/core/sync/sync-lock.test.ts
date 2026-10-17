// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSyncLockHeld, SYNC_LOCK_NAME, withSyncLock } from "./sync-lock";

type LockCb = (lock: { name: string } | null) => Promise<void>;

/**
 * A `navigator.locks` stand-in with the real API's one property that matters here: `request`
 * rejects with whatever the callback rejects with. `busy` makes an `ifAvailable` request hand the
 * callback `null`, as the browser does when another tab holds the lock.
 */
function installFakeLocks(opts: { busy?: boolean; broken?: boolean } = {}) {
    const request = vi.fn(
        async (name: string, optsOrCb: unknown, maybeCb?: LockCb): Promise<void> => {
            if (opts.broken) throw new Error("locks unavailable");
            const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as LockCb;
            const o = (typeof optsOrCb === "function" ? {} : optsOrCb) as { ifAvailable?: boolean };
            if (o.ifAvailable && opts.busy) return cb(null);
            return cb({ name });
        },
    );
    vi.stubGlobal("navigator", { locks: { request } });
    return request;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("withSyncLock", () => {
    // Regression: `locks.request` rejects with the callback's error too. The single-tab fallback
    // used to catch that and run `fn` a SECOND time, outside the cross-tab lock — a failed restore
    // phase-5 pull re-ran unlocked, a drain that threw re-ran while another tab may have been draining.
    it("a rejection from fn propagates and fn runs exactly once — no unlocked re-run", async () => {
        const request = installFakeLocks();
        const fn = vi.fn().mockRejectedValue(new Error("boom"));

        await expect(withSyncLock(fn)).rejects.toThrow("boom");

        expect(fn).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
        expect(isSyncLockHeld()).toBe(false);
    });

    it("ifAvailable: a rejection from fn propagates and fn runs exactly once", async () => {
        installFakeLocks();
        const fn = vi.fn().mockRejectedValue(new Error("boom"));

        await expect(withSyncLock(fn, { ifAvailable: true })).rejects.toThrow("boom");

        expect(fn).toHaveBeenCalledTimes(1);
        expect(isSyncLockHeld()).toBe(false);
    });

    it("a successful fn runs once under the named lock and reports ran=true", async () => {
        const request = installFakeLocks();
        const fn = vi.fn().mockResolvedValue(undefined);

        await expect(withSyncLock(fn)).resolves.toBe(true);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]?.[0]).toBe(SYNC_LOCK_NAME);
    });

    it("ifAvailable while another tab holds the lock: fn is skipped and ran=false", async () => {
        installFakeLocks({ busy: true });
        const fn = vi.fn().mockResolvedValue(undefined);

        await expect(withSyncLock(fn, { ifAvailable: true })).resolves.toBe(false);

        expect(fn).not.toHaveBeenCalled();
    });

    it("a genuine Locks API failure still falls back to a single local run", async () => {
        installFakeLocks({ broken: true });
        const fn = vi.fn().mockResolvedValue(undefined);

        await expect(withSyncLock(fn)).resolves.toBe(true);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(isSyncLockHeld()).toBe(false);
    });

    it("the fallback run's own rejection propagates unwrapped", async () => {
        installFakeLocks({ broken: true });
        const fn = vi.fn().mockRejectedValue(new Error("fallback boom"));

        await expect(withSyncLock(fn)).rejects.toThrow("fallback boom");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("same-tab reentrancy: a nested withSyncLock runs inline without a second request", async () => {
        const request = installFakeLocks();
        const inner = vi.fn().mockResolvedValue(undefined);
        let heldInside = false;

        await withSyncLock(async () => {
            heldInside = isSyncLockHeld();
            await withSyncLock(inner);
        });

        expect(heldInside).toBe(true);
        expect(inner).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
        expect(isSyncLockHeld()).toBe(false);
    });
});
