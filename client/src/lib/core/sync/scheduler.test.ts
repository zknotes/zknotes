// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { APP_EVENTS } from "$lib/core/constants/events";

const {
    migrateLegacyItemsMock,
    hasPendingMutationsMock,
    pushPendingMutationsMock,
    pullAndMergeMock,
    flushIndexMock,
    startSyncMock,
    endSyncMock,
    setOnlineMock,
    refreshPendingCountMock,
    nextMutationRetryAtMock,
    onMutationQueueChangedMock,
    queue,
    storeState,
} = vi.hoisted(() => ({
    migrateLegacyItemsMock: vi.fn().mockResolvedValue(undefined),
    hasPendingMutationsMock: vi.fn().mockResolvedValue(false),
    pushPendingMutationsMock: vi.fn().mockResolvedValue(undefined),
    pullAndMergeMock: vi.fn().mockResolvedValue({ itemCount: 0, changedIds: [] }),
    flushIndexMock: vi.fn().mockResolvedValue(undefined),
    startSyncMock: vi.fn(),
    endSyncMock: vi.fn(),
    setOnlineMock: vi.fn(),
    refreshPendingCountMock: vi.fn().mockResolvedValue(undefined),
    // null = an empty queue; a number = the earliest due time (ms)
    nextMutationRetryAtMock: vi.fn<() => Promise<number | null>>().mockResolvedValue(null),
    onMutationQueueChangedMock: vi.fn(),
    queue: { listener: null as null | (() => void) },
    storeState: { isOnline: true, isSuspended: false },
}));

vi.mock("./engine", () => ({
    migrateLegacyItems: migrateLegacyItemsMock,
    hasPendingMutations: hasPendingMutationsMock,
    pushPendingMutations: pushPendingMutationsMock,
    pullAndMerge: pullAndMergeMock,
    nextMutationRetryAt: nextMutationRetryAtMock,
    onMutationQueueChanged: onMutationQueueChangedMock,
}));

vi.mock("$lib/core/search", () => ({
    flushIndex: flushIndexMock,
}));

vi.mock("$lib/core/sync/store.svelte", () => ({
    syncStore: {
        startSync: startSyncMock,
        endSync: endSyncMock,
        setOnline: setOnlineMock,
        refreshPendingCount: refreshPendingCountMock,
        get isOnline() {
            return storeState.isOnline;
        },
        get isSuspended() {
            return storeState.isSuspended;
        },
    },
}));

import { MINUTE_MS } from "$lib/core/utils/duration";
import { createSyncScheduler, FOCUS_SYNC_MIN_GAP_MS, RETRY_TIMER_FLOOR_MS } from "./scheduler";

beforeEach(() => {
    storeState.isOnline = true;
    storeState.isSuspended = false;
    queue.listener = null;
    pullAndMergeMock.mockResolvedValue({ itemCount: 0, changedIds: [] });
    nextMutationRetryAtMock.mockResolvedValue(null);
    onMutationQueueChangedMock.mockImplementation((listener: () => void) => {
        queue.listener = listener;
        return () => {
            queue.listener = null;
        };
    });
});

describe("createSyncScheduler", () => {
    let onTreeChanged: Mock<(changedIds: string[]) => void>;
    let scheduler: ReturnType<typeof createSyncScheduler>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        onTreeChanged = vi.fn<(changedIds: string[]) => void>();
        scheduler = createSyncScheduler({ onTreeChanged });
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
        });
    });

    afterEach(() => {
        scheduler.stop();
        vi.useRealTimers();
    });

    it("syncNow runs migrate → push → pull pipeline", async () => {
        await scheduler.syncNow();

        expect(migrateLegacyItemsMock).toHaveBeenCalledBefore(pushPendingMutationsMock);
        expect(pushPendingMutationsMock).toHaveBeenCalledBefore(pullAndMergeMock);
        expect(startSyncMock).toHaveBeenCalledOnce();
        expect(endSyncMock).toHaveBeenCalledOnce();
    });

    it("syncNow notifies tree when pull returns changed items", async () => {
        pullAndMergeMock.mockResolvedValueOnce({ itemCount: 2, changedIds: ["a", "b"] });

        await scheduler.syncNow();

        expect(onTreeChanged).toHaveBeenCalledWith(["a", "b"]);
    });

    it("syncNow notifies tree when push had pending mutations even if pull is empty", async () => {
        hasPendingMutationsMock.mockResolvedValueOnce(true);

        await scheduler.syncNow();

        expect(onTreeChanged).toHaveBeenCalledWith([]);
    });

    it("attach wires online state and refreshes pending count", () => {
        scheduler.attach();

        expect(setOnlineMock).toHaveBeenCalledWith(navigator.onLine);
        expect(refreshPendingCountMock).toHaveBeenCalledOnce();
    });

    it("going online triggers syncNow", async () => {
        scheduler.attach();
        pullAndMergeMock.mockClear();

        window.dispatchEvent(new Event("online"));
        await vi.runOnlyPendingTimersAsync();

        expect(pullAndMergeMock).toHaveBeenCalled();
    });

    it("hidden tab flushes search index", async () => {
        scheduler.startBackground();
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
        });

        document.dispatchEvent(new Event("visibilitychange"));
        await vi.runOnlyPendingTimersAsync();

        expect(flushIndexMock).toHaveBeenCalledOnce();
    });

    it("visible tab triggers syncNow", async () => {
        scheduler.startBackground();
        pullAndMergeMock.mockClear();

        document.dispatchEvent(new Event("visibilitychange"));
        await vi.runOnlyPendingTimersAsync();

        expect(pullAndMergeMock).toHaveBeenCalled();
    });

    it("focus starts no cycle within 30 s of the last one, and does after", async () => {
        scheduler.startBackground();

        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(0);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2_000);
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(0);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(FOCUS_SYNC_MIN_GAP_MS - 2_000);
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(0);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(2);
    });

    it("a tab switch still syncs at once, right after a cycle", async () => {
        scheduler.startBackground();
        await scheduler.syncNow();

        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);

        expect(pullAndMergeMock).toHaveBeenCalledTimes(2);
    });

    it("the periodic pull runs exactly 1 minute after a cycle that brought changes", async () => {
        pullAndMergeMock.mockResolvedValueOnce({ itemCount: 1, changedIds: ["x"] });
        await scheduler.syncNow();
        scheduler.startBackground();
        pullAndMergeMock.mockClear();

        await vi.advanceTimersByTimeAsync(MINUTE_MS - 1);
        expect(pullAndMergeMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(pullAndMergeMock).toHaveBeenCalledOnce();
    });

    it("the periodic pull waits 5 minutes after an empty pull", async () => {
        await scheduler.syncNow();
        scheduler.startBackground();
        pullAndMergeMock.mockClear();

        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS - 1);
        expect(pullAndMergeMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(pullAndMergeMock).toHaveBeenCalledOnce();
    });

    it("a slow pull does not push the next periodic pull a whole tick later", async () => {
        // A pull that takes 500 ms. The old one-minute tick compared against the END of the pull,
        // missed by those 500 ms and waited another tick: 2 pulls by t = 122 s instead of 3.
        pullAndMergeMock.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(() => resolve({ itemCount: 1, changedIds: ["x"] }), 500),
                ),
        );
        const first = scheduler.syncNow();
        await vi.advanceTimersByTimeAsync(500);
        await first;
        scheduler.startBackground();

        await vi.advanceTimersByTimeAsync(122_000 - 500);

        expect(pullAndMergeMock).toHaveBeenCalledTimes(3);
    });

    it("a focus cycle pushes the next periodic pull out by a full interval", async () => {
        pullAndMergeMock.mockResolvedValue({ itemCount: 1, changedIds: ["x"] });
        await scheduler.syncNow();
        scheduler.startBackground();

        await vi.advanceTimersByTimeAsync(40_000);
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(0);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(2);

        // The timer armed for t = 60 s was replaced by one for t = 100 s.
        await vi.advanceTimersByTimeAsync(MINUTE_MS - 1);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(3);
    });

    it("vaultItemsChanged event invalidates tree and broadcasts cross-tab", async () => {
        scheduler.startBackground();
        onTreeChanged.mockClear();

        window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
        await vi.runOnlyPendingTimersAsync();

        expect(onTreeChanged).toHaveBeenCalledWith([]);
    });
});

describe("createSyncScheduler — lifecycle after stop()", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    // Regression: the (app) layout reaches startBackground() at the end of an async unlock sequence
    // (syncNow → index build) that can outlive the component. Registering the interval and the
    // listeners after stop() left an orphan scheduler nobody could stop — a stale closure that kept
    // calling syncNow every minute after logout.
    it("startBackground after stop is a no-op: no interval, no listeners, no cross-tab channel", async () => {
        const onTreeChanged = vi.fn<(changedIds: string[]) => void>();
        const scheduler = createSyncScheduler({ onTreeChanged });
        scheduler.attach();
        scheduler.stop();
        vi.clearAllMocks();

        scheduler.startBackground();

        await vi.advanceTimersByTimeAsync(6 * MINUTE_MS);
        expect(pushPendingMutationsMock).not.toHaveBeenCalled();
        expect(pullAndMergeMock).not.toHaveBeenCalled();

        window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
        await vi.runOnlyPendingTimersAsync();
        expect(onTreeChanged).not.toHaveBeenCalled();
    });

    it("attach after stop is a no-op: going online does not sync", async () => {
        const onTreeChanged = vi.fn<(changedIds: string[]) => void>();
        const scheduler = createSyncScheduler({ onTreeChanged });
        scheduler.stop();
        vi.clearAllMocks();

        scheduler.attach();
        window.dispatchEvent(new Event("online"));
        await vi.runOnlyPendingTimersAsync();

        expect(pushPendingMutationsMock).not.toHaveBeenCalled();
    });

    it("startBackground is idempotent: a second call does not double-register the listeners", async () => {
        const onTreeChanged = vi.fn<(changedIds: string[]) => void>();
        const scheduler = createSyncScheduler({ onTreeChanged });
        scheduler.startBackground();
        scheduler.startBackground();

        window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
        await vi.runOnlyPendingTimersAsync();

        expect(onTreeChanged).toHaveBeenCalledTimes(1);
        scheduler.stop();
    });
});

describe("createSyncScheduler — retry timer", () => {
    let scheduler: ReturnType<typeof createSyncScheduler>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        scheduler = createSyncScheduler({ onTreeChanged: vi.fn() });
    });
    afterEach(() => {
        scheduler.stop();
        vi.useRealTimers();
    });

    it("a mutation due in 5 s is pushed after 5 s, not at the next 1/5-minute pull", async () => {
        nextMutationRetryAtMock.mockResolvedValue(Date.now() + 5_000);
        scheduler.startBackground();

        await vi.advanceTimersByTimeAsync(4_999);
        expect(pullAndMergeMock).not.toHaveBeenCalled();

        nextMutationRetryAtMock.mockResolvedValue(null); // the cycle drains it
        await vi.advanceTimersByTimeAsync(1);
        expect(pushPendingMutationsMock).toHaveBeenCalledOnce();
        expect(pullAndMergeMock).toHaveBeenCalledOnce();
    });

    it("a mutation that is already due waits for the 1 s floor", async () => {
        nextMutationRetryAtMock.mockResolvedValue(0);
        scheduler.startBackground();

        await vi.advanceTimersByTimeAsync(RETRY_TIMER_FLOOR_MS - 1);
        expect(pullAndMergeMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(pullAndMergeMock).toHaveBeenCalledOnce();
    });

    it("the floor doubles while a row stays due after each fire (no hot loop)", async () => {
        nextMutationRetryAtMock.mockResolvedValue(0);
        scheduler.startBackground();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(pullAndMergeMock).toHaveBeenCalledTimes(3);
    });

    it("offline, the timer fires without starting a cycle", async () => {
        nextMutationRetryAtMock.mockResolvedValue(Date.now() + 2_000);
        storeState.isOnline = false;
        scheduler.startBackground();

        await vi.advanceTimersByTimeAsync(10_000);
        expect(pullAndMergeMock).not.toHaveBeenCalled();
    });

    it("after stop() the armed timer never fires", async () => {
        nextMutationRetryAtMock.mockResolvedValue(Date.now() + 2_000);
        scheduler.startBackground();
        await vi.advanceTimersByTimeAsync(0);

        scheduler.stop();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pullAndMergeMock).not.toHaveBeenCalled();
        expect(queue.listener).toBeNull();
    });

    it("a queue change re-arms the timer (a failed foreground push retries within ~1 s)", async () => {
        scheduler.startBackground();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pullAndMergeMock).not.toHaveBeenCalled();

        // pushItem failed → enqueueMutation (attempt_count 0 → due at once) → the listener fires.
        nextMutationRetryAtMock.mockResolvedValue(0);
        queue.listener?.();
        await vi.advanceTimersByTimeAsync(RETRY_TIMER_FLOOR_MS);
        expect(pullAndMergeMock).toHaveBeenCalledOnce();
    });

    it("the timer is not armed before startBackground()", async () => {
        nextMutationRetryAtMock.mockResolvedValue(0);
        await scheduler.syncNow();
        pullAndMergeMock.mockClear();

        await vi.advanceTimersByTimeAsync(10_000);
        expect(pullAndMergeMock).not.toHaveBeenCalled();
    });
});

describe("createSyncScheduler — one cycle per tab at a time", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a second syncNow() while a cycle runs joins it instead of pulling again", async () => {
        const scheduler = createSyncScheduler({ onTreeChanged: vi.fn() });
        let release: () => void = () => {};
        pullAndMergeMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () => resolve({ itemCount: 0, changedIds: [] });
                }),
        );

        const first = scheduler.syncNow();
        await vi.waitFor(() => expect(pullAndMergeMock).toHaveBeenCalledOnce());
        const second = scheduler.syncNow();
        release();
        await Promise.all([first, second]);

        expect(pullAndMergeMock).toHaveBeenCalledOnce();

        await scheduler.syncNow();
        expect(pullAndMergeMock).toHaveBeenCalledTimes(2);
        scheduler.stop();
    });
});
