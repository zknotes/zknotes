/**
 * Sync store — tracks the synchronisation status and the time of the last successful sync.
 */
import { untrack } from "svelte";
import { getPendingMutationCount } from "$lib/core/db";
import { getUnsyncedWork } from "./unsynced-work";

/**
 * A tight loop of enqueueMutation calls (a bulk trash/delete, say) used to trigger one
 * getPendingMutationCount + getUnsyncedWork pair PER call — both do a full
 * IndexedDB scan. Coalescing calls that land within this window into one shared read cuts that back
 * to one pair for the whole burst, whether callers `await` it or fire it with `void`.
 */
const PENDING_COUNT_DEBOUNCE_MS = 50;

function createSyncStore() {
    let lastSyncAt = $state<number>(0);
    // The scheduler's cycle (startSync/endSync). `isSyncing` also counts the pushes in flight below.
    let cycleActive = $state<boolean>(false);
    // Pushes in flight outside a cycle as well — a note save goes straight to /items/batch
    // (pushItem), past the mutation queue, so without this counter nothing showed it was sending.
    let pushesInFlight = $state<number>(0);
    // Initially false — set from navigator.onLine when the layout mounts (SSR-safe).
    let isOnline = $state<boolean>(true);
    // The last server rejection (a file item whose chunk set was not committed, say). It is exposed
    // so a failed push is not silent — without it, rejected items stay `dirty` forever with no signal
    // in the UI.
    let lastError = $state<string | null>(null);
    // How many mutations are queued for push (offline/pending UX). Not a separate source
    // of truth — only a cached reflection of `mutation-queue`; the engine refreshes it on
    // enqueue/drain through refreshPendingCount.
    let pendingCount = $state<number>(0);
    // Items parked with `sync_error` (removed from the mutation queue). The panel must not say
    // "All changes saved" while any of these remain.
    let failedCount = $state<number>(0);
    // Bulk operations (a full backup import, say) suspend push+pull so an in-flight sync cannot
    // overwrite freshly imported ciphertexts with old server state or a wrong-version applySucceeded.
    let suspended = $state<boolean>(false);
    // Getters for unsaved editor state (NoteAutosave registers `isDirty || isSaving`). The store does
    // not copy that state — it reads the getter, so NoteAutosave stays its one source of truth, and
    // core does not import modules.
    let unsavedSources = $state.raw<ReadonlyArray<() => boolean>>([]);

    let pendingRefresh: Promise<void> | null = null;

    async function doRefreshPendingCount(): Promise<void> {
        try {
            pendingCount = await getPendingMutationCount();
            const work = await getUnsyncedWork();
            failedCount = work.failedCount;
        } catch {
            // IDB unavailable (SSR/teardown, say) — keep the last value.
        }
    }

    return {
        get lastSyncAt() {
            return lastSyncAt;
        },
        get isSyncing() {
            return cycleActive || pushesInFlight > 0;
        },
        /** Local changes are on their way to the server; `isSyncing` without it is a cycle's pull. */
        get isPushing() {
            return pushesInFlight > 0;
        },
        get isOnline() {
            return isOnline;
        },
        get lastError() {
            return lastError;
        },
        get pendingCount() {
            return pendingCount;
        },
        get failedCount() {
            return failedCount;
        },
        get isSuspended() {
            return suspended;
        },
        /** True while an open note holds edits that are not in IndexedDB yet (autosave is pending or running). */
        get hasUnsavedEdits() {
            return unsavedSources.some((source) => source());
        },
        /**
         * Registers a getter for unsaved editor state; returns the function that removes it again.
         * The list is read untracked: callers register from an `$effect` (the note page mounts
         * NoteAutosave in one), and a tracked read there would make the effect depend on the very
         * list it writes — an infinite effect loop.
         */
        registerUnsavedEdits(source: () => boolean): () => void {
            unsavedSources = [...untrack(() => unsavedSources), source];
            return () => {
                unsavedSources = untrack(() => unsavedSources).filter((s) => s !== source);
            };
        },
        /**
         * Reads the current count from the mutation queue in IDB. Best-effort (a UI counter — it
         * must not throw). Debounced: concurrent calls within
         * PENDING_COUNT_DEBOUNCE_MS share one read instead of one each.
         */
        refreshPendingCount(): Promise<void> {
            if (!pendingRefresh) {
                pendingRefresh = new Promise<void>((resolve) => {
                    setTimeout(() => {
                        void doRefreshPendingCount().finally(() => {
                            pendingRefresh = null;
                            resolve();
                        });
                    }, PENDING_COUNT_DEBOUNCE_MS);
                });
            }
            return pendingRefresh;
        },
        // markSync* govern the outcome only (lastError/lastSyncAt). `isSyncing` comes from the
        // scheduler's cycle (startSync/endSync) plus the push counter (beginPush/endPush) — so the
        // spinner does not flicker when the engine calls markSyncSuccess per item in the middle of a
        // cycle.
        markSyncError(message: string) {
            lastError = message;
        },
        /** A drain parked an item with `sync_error` — keep the error visible until refresh. */
        noteParkedFailure() {
            failedCount += 1;
        },
        markSyncSuccess() {
            lastSyncAt = Date.now();
            // Do not clear lastError while parked sync_error rows still exist — a later successful
            // batch must not tell the UI "All changes saved" over a note that will never retry.
            if (failedCount === 0) lastError = null;
        },
        startSync() {
            cycleActive = true;
        },
        endSync() {
            cycleActive = false;
        },
        /** A push to the server has started (the engine pairs it with endPush in a `finally`). */
        beginPush() {
            pushesInFlight += 1;
        },
        endPush() {
            pushesInFlight = Math.max(0, pushesInFlight - 1);
        },
        setOnline(v: boolean) {
            isOnline = v;
        },
        /** Stop push/pull (a backup import). The mutation queue still accepts writes. */
        suspendSync() {
            suspended = true;
        },
        resumeSync() {
            suspended = false;
        },
    };
}

export const syncStore = createSyncStore();
