/**
 * The sign-in screen used to ask the server once, on load. When the server was away the answer was
 * lost and never asked for again, so the screen stayed half empty after the server came back. It
 * now keeps asking while — and only while — the server is unreachable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETRY_DELAYS_MS, ServerReachability } from "./server-reachability.svelte";

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
}

/** Lets the probe's promise chain settle without moving the clock. */
async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

const instances: ServerReachability[] = [];
function create(probe: () => Promise<void>, onRecover?: () => void): ServerReachability {
    const r = new ServerReachability(probe, { onRecover });
    instances.push(r);
    return r;
}

beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
});

afterEach(() => {
    for (const r of instances.splice(0)) r.stop();
    vi.useRealTimers();
});

const down = () => Promise.reject(new TypeError("Failed to fetch"));
const up = () => Promise.resolve();

describe("ServerReachability", () => {
    it("asks once on start, and never polls a server that answers", async () => {
        const probe = vi.fn(up);
        const r = create(probe);

        r.start();
        await settle();
        expect(r.status).toBe("reachable");

        await vi.advanceTimersByTimeAsync(60_000);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it("retries on a growing delay while the server is away, and reports the recovery once", async () => {
        const probe = vi.fn().mockImplementationOnce(down).mockImplementationOnce(down);
        probe.mockImplementation(up);
        const onRecover = vi.fn();
        const r = create(probe, onRecover);

        r.start();
        await settle();
        expect(r.status).toBe("unreachable");
        expect(probe).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(r.status).toBe("unreachable");

        // The second wait is longer than the first.
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
        expect(probe).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync((RETRY_DELAYS_MS[1] ?? 0) - (RETRY_DELAYS_MS[0] ?? 0));
        expect(probe).toHaveBeenCalledTimes(3);

        expect(r.status).toBe("reachable");
        expect(onRecover).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(probe).toHaveBeenCalledTimes(3);
    });

    it("a first answer is not a recovery", async () => {
        const onRecover = vi.fn();
        const r = create(vi.fn(up), onRecover);
        r.start();
        await settle();
        expect(onRecover).not.toHaveBeenCalled();
    });

    it("checks at once when the browser reports a connection", async () => {
        const probe = vi.fn().mockImplementationOnce(down);
        probe.mockImplementation(up);
        const r = create(probe);
        r.start();
        await settle();

        window.dispatchEvent(new Event("online"));
        await settle();

        expect(probe).toHaveBeenCalledTimes(2);
        expect(r.status).toBe("reachable");
    });

    it("does not poll from a hidden tab, and checks as soon as it is shown again", async () => {
        const probe = vi.fn<() => Promise<void>>(down);
        const r = create(probe);
        r.start();
        await settle();
        expect(probe).toHaveBeenCalledTimes(1);

        setVisibility("hidden");
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        // The retry armed before the tab hid fires once; it does not arm another.
        expect(probe).toHaveBeenCalledTimes(2);

        probe.mockImplementation(up);
        setVisibility("visible");
        await settle();
        expect(probe).toHaveBeenCalledTimes(3);
        expect(r.status).toBe("reachable");
    });

    it("markUnreachable starts the retries when another request found the server away", async () => {
        const probe = vi.fn(up);
        const onRecover = vi.fn();
        const r = create(probe, onRecover);
        r.start();
        await settle();
        expect(r.status).toBe("reachable");

        r.markUnreachable();
        expect(r.status).toBe("unreachable");

        await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(r.status).toBe("reachable");
        expect(onRecover).toHaveBeenCalledTimes(1);
    });

    it("checkNow shares a check already in flight", async () => {
        let release: () => void = () => {};
        const probe = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const r = create(probe);
        r.start();
        const again = r.checkNow();
        expect(r.checking).toBe(true);

        release();
        expect(await again).toBe(true);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(r.checking).toBe(false);
    });

    it("stop ends the retries", async () => {
        const probe = vi.fn<() => Promise<void>>(down);
        const r = create(probe);
        r.start();
        await settle();

        r.stop();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        window.dispatchEvent(new Event("online"));
        await settle();

        expect(probe).toHaveBeenCalledTimes(1);
    });
});
