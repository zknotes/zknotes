/**
 * The sync scheduler — it orchestrates the push/pull cycle, lifted out of (app)/+layout.svelte:
 *  - doSync(): migrate → push the queue → pull (called on unlock, online and visibility)
 *  - an adaptive background pull (1 minute while there are changes, 5 minutes when it is quiet),
 *    counted from the end of the last cycle
 *  - a retry timer: a queued mutation is pushed when its backoff runs out, not at the next pull
 *  - the online/offline + visibility/pagehide listeners
 *  - BroadcastChannel("vault-sync") — the cross-tab tree invalidation
 */
import { APP_EVENTS } from "$lib/core/constants/events";
import { flushIndex } from "$lib/core/search";
import { syncStore } from "$lib/core/sync/store.svelte";
import { MINUTE_MS, SECOND_MS } from "$lib/core/utils/duration";
import {
    hasPendingMutations,
    migrateLegacyItems,
    nextMutationRetryAt,
    onMutationQueueChanged,
    pullAndMerge,
    pushPendingMutations,
} from "./engine";
import { withSyncLock } from "./sync-lock";

/**
 * The retry timer never fires sooner than this after it is armed — even for a mutation that is
 * already due (a fresh enqueue, say). The floor doubles for every fire after which a row was still
 * due (another tab held the lock, or a row the drain cannot move), up to a minute, so a row that
 * stays due cannot turn the timer into a hot loop.
 */
export const RETRY_TIMER_FLOOR_MS = SECOND_MS;
const RETRY_TIMER_MAX_FLOOR_MS = MINUTE_MS;

/**
 * Focus coming back to the window starts no cycle when the last one began less than this long ago.
 * Focus returns far more often than the user means "refresh" — an alt-tab, a closed file picker, a
 * click out of DevTools. A tab switch (visibilitychange) still syncs at once.
 */
export const FOCUS_SYNC_MIN_GAP_MS = 30 * SECOND_MS;

export interface SyncSchedulerOptions {
    /**
     * Called when a sync changes local items. `changedIds` holds the IDs of the items the pull
     * updated — the layout invalidates their note queries too, so the editor shows the new content.
     */
    onTreeChanged: (changedIds: string[]) => void;
}

export interface SyncScheduler {
    /** The full cycle: the legacy migration → push the queue → pull. Safe to call at any time. */
    syncNow(): Promise<void>;
    /** Registers the online/offline listeners and initialises syncStore.isOnline. */
    attach(): void;
    /**
     * Starts the background work after an unlock: the visibility and pagehide listeners,
     * the cross-tab channel, the vault-items-changed listener, the periodic pull and the retry timer.
     */
    startBackground(): void;
    /** Removes every listener and stops the timers. */
    stop(): void;
}

export function createSyncScheduler(opts: SyncSchedulerOptions): SyncScheduler {
    let lastPullHadChanges = true;
    /** When the last cycle in this tab actually began (it held the lock) — the focus gap counts from here. */
    let lastCycleAt = 0;
    let backgroundStarted = false;
    let pullTimer: ReturnType<typeof setTimeout> | undefined;
    let syncChannel: BroadcastChannel | undefined;
    /**
     * Set by stop(). The layout reaches startBackground() at the end of an async unlock sequence
     * (syncNow → index build) that can outlive the component; registering listeners and the
     * interval after stop() would leave an orphan scheduler nobody can stop — a stale closure
     * that keeps syncing after logout (401 → a hard redirect a minute later) or double-drives the
     * next user's sync.
     */
    let disposed = false;
    /** The cycle running in this tab — a second syncNow() joins it instead of starting another. */
    let cycleInFlight: Promise<void> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryArmPending = false;
    /** Only the newest arm may set the timer — an older IDB read that resolves late is stale. */
    let retryArmSeq = 0;
    /** Timer fires in a row after which a mutation was still due — it doubles the floor. */
    let retryStreak = 0;
    let unsubscribeQueue: (() => void) | undefined;

    async function runSyncCycle(): Promise<void> {
        // A bulk import suspends the whole cycle so a pull does not overwrite freshly imported items.
        if (syncStore.isSuspended) return;
        lastCycleAt = Date.now();
        syncStore.startSync();
        try {
            await migrateLegacyItems();
            // Check before the push — the push clears the dirty flag, and the tree invalidation clears the spinner.
            const hadPending = await hasPendingMutations();
            await pushPendingMutations();
            const pullRes = await pullAndMerge();
            lastPullHadChanges = pullRes.itemCount > 0;
            if (pullRes.itemCount > 0 || hadPending) {
                opts.onTreeChanged(pullRes.changedIds);
                // Tell the other tabs which note queries to invalidate (not only the tree).
                syncChannel?.postMessage({
                    type: "sync-changed",
                    changedIds: pullRes.changedIds,
                });
            }
        } catch (e) {
            console.error("Sync failed", e);
        } finally {
            syncStore.endSync();
        }
    }

    /**
     * A Web Lock — one tab drains push+pull; the others skip the interval/focus cycle.
     * A foreground `pushItem` waits on the same lock (see sync-lock.ts) rather than racing the drain.
     *
     * Within one tab a call made while a cycle runs joins that cycle: withSyncLock's same-tab
     * reentrancy would otherwise run the second cycle inline, in parallel with the first. Whatever
     * lands in the queue meanwhile is picked up by the retry timer armed when the cycle ends.
     */
    function syncNow(): Promise<void> {
        if (syncStore.isSuspended) return Promise.resolve();
        if (cycleInFlight) return cycleInFlight;
        const cycle = (async () => {
            try {
                await withSyncLock(() => runSyncCycle(), { ifAvailable: true });
            } finally {
                cycleInFlight = null;
                armRetryTimer();
                armPullTimer();
            }
        })();
        cycleInFlight = cycle;
        return cycle;
    }

    /**
     * Arms the periodic pull for one interval after the cycle that just ended, whatever started it.
     * It used to be a one-minute tick comparing against the END of the last pull, which missed by
     * the cycle's own duration and waited a whole extra tick: 2 minutes instead of 1, 6 instead of 5.
     * A no-op until startBackground() and after stop().
     */
    function armPullTimer(): void {
        if (disposed || !backgroundStarted) return;
        clearTimeout(pullTimer);
        const interval = lastPullHadChanges ? MINUTE_MS : 5 * MINUTE_MS;
        pullTimer = setTimeout(() => {
            pullTimer = undefined;
            // A suspended or skipped syncNow() runs no cycle — re-arm here too, or the pull stops.
            void syncNow().finally(armPullTimer);
        }, interval);
    }

    /**
     * Arms the retry timer for the earliest due mutation. Calls within one tick share one IDB read
     * (a burst of enqueues arms once). A no-op until startBackground() and after stop().
     */
    function armRetryTimer(): void {
        if (disposed || !backgroundStarted || retryArmPending) return;
        retryArmPending = true;
        queueMicrotask(async () => {
            retryArmPending = false;
            const seq = ++retryArmSeq;
            let dueAt: number | null;
            try {
                dueAt = await nextMutationRetryAt();
            } catch {
                return; // IDB unavailable (teardown) — the next cycle re-arms
            }
            if (disposed || !backgroundStarted || seq !== retryArmSeq) return;
            clearTimeout(retryTimer);
            retryTimer = undefined;
            if (dueAt === null) {
                retryStreak = 0;
                return;
            }
            const now = Date.now();
            // The last fire moved the queue on (drained it, or pushed the backoff into the future).
            if (dueAt > now) retryStreak = 0;
            const floor = Math.min(
                RETRY_TIMER_FLOOR_MS * 2 ** retryStreak,
                RETRY_TIMER_MAX_FLOOR_MS,
            );
            retryTimer = setTimeout(onRetryTimer, Math.max(dueAt - now, floor));
        });
    }

    function onRetryTimer(): void {
        retryTimer = undefined;
        // Offline: the "online" event starts a cycle anyway. Suspended: the bulk operation pushes the
        // queue itself when it finishes. Either way the next enqueue or cycle re-arms.
        if (disposed || !syncStore.isOnline || syncStore.isSuspended) return;
        retryStreak += 1;
        void syncNow();
    }

    const onOnline = () => {
        syncStore.setOnline(true);
        // Start a push+pull at once when the connection comes back.
        void syncNow();
    };
    const onOffline = () => syncStore.setOnline(false);

    const onVisibilityChange = () => {
        if (document.visibilityState === "visible") {
            void syncNow();
        } else {
            void flushIndex();
        }
    };

    // `visibilitychange` fires only on a tab switch within the same browser — not when the user
    // switches focus from another browser window or application. The `focus` event covers that case,
    // at most once per FOCUS_SYNC_MIN_GAP_MS.
    const onWindowFocus = () => {
        if (Date.now() - lastCycleAt < FOCUS_SYNC_MIN_GAP_MS) return;
        void syncNow();
    };

    const onPageHide = () => {
        void flushIndex();
    };

    const onVaultItemsChanged = () => {
        // A local event — the changedIds are unknown, so the layout invalidates every tree query.
        opts.onTreeChanged([]);
        syncChannel?.postMessage({ type: "tree-items-changed" });
    };

    function attach(): void {
        if (disposed) return;
        // Offline detection (offline-first).
        syncStore.setOnline(navigator.onLine);
        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);
        // Show a leftover queue — one closed while offline, say — at once, before the first drain.
        void syncStore.refreshPendingCount();
    }

    function startBackground(): void {
        // No-op after stop(), and idempotent (a second call must not double-register the listeners).
        if (disposed || backgroundStarted) return;
        backgroundStarted = true;
        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("focus", onWindowFocus);
        window.addEventListener("pagehide", onPageHide);

        if (typeof BroadcastChannel !== "undefined") {
            syncChannel = new BroadcastChannel("vault-sync");
            syncChannel.onmessage = (event) => {
                const data = event.data;
                // The legacy string plus the new object payload
                if (data === "tree-items-changed" || data?.type === "tree-items-changed") {
                    opts.onTreeChanged([]);
                    return;
                }
                if (data?.type === "sync-changed" && Array.isArray(data.changedIds)) {
                    // Invalidate the tree + the specific note ids (layout onTreeChanged).
                    opts.onTreeChanged(data.changedIds as string[]);
                }
            };
        }

        window.addEventListener(APP_EVENTS.vaultItemsChanged, onVaultItemsChanged);

        // The adaptive periodic pull: a full syncNow (the Web Lock) so both the pending queue and
        // the pull go through the leader. The unlock's first cycle has just ended, so count from
        // now.
        armPullTimer();

        // A failed push (foreground or drain) changes the queue → re-arm; arm once for what the
        // unlock's first cycle left behind.
        unsubscribeQueue = onMutationQueueChanged(armRetryTimer);
        armRetryTimer();
    }

    function stop(): void {
        disposed = true;
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("focus", onWindowFocus);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
        window.removeEventListener(APP_EVENTS.vaultItemsChanged, onVaultItemsChanged);
        syncChannel?.close();
        syncChannel = undefined;
        backgroundStarted = false;
        clearTimeout(pullTimer);
        pullTimer = undefined;
        unsubscribeQueue?.();
        unsubscribeQueue = undefined;
        clearTimeout(retryTimer);
        retryTimer = undefined;
    }

    return { syncNow, attach, startBackground, stop };
}
