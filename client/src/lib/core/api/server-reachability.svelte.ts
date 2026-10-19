import { RETRY_DELAYS_S } from "$lib/core/constants/reachability";
import { SECOND_MS } from "$lib/core/utils/duration";

export type ReachabilityStatus = "checking" | "reachable" | "unreachable";

/** The wait before each automatic retry while the server is away; the last one repeats. */
export const RETRY_DELAYS_MS: readonly number[] = RETRY_DELAYS_S.map((s) => s * SECOND_MS);

export type ServerReachabilityOptions = {
    /** Called once each time the server answers again after having been unreachable. */
    onRecover?: () => void;
};

/**
 * Whether the server answers, for a screen that cannot work without it (sign-in). It asks once on
 * `start()`, then — only while the answer is "no" — again after a growing delay, at once when the
 * browser reports a connection, and when the tab comes back into view. A server that answers is
 * never polled, and a hidden tab does not poll at all.
 *
 * `probe` is the screen's own request: it rejects when the server cannot be reached, and a success
 * doubles as loading whatever the screen needed from the server, so a recovery fills the screen in
 * without a reload.
 */
export class ServerReachability {
    status = $state<ReachabilityStatus>("checking");
    /** A check is in flight — for the spinner on the "Try now" button. */
    checking = $state(false);

    readonly #probe: () => Promise<void>;
    readonly #onRecover: (() => void) | undefined;
    #started = false;
    #attempt = 0;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #inflight: Promise<boolean> | null = null;

    constructor(probe: () => Promise<void>, opts: ServerReachabilityOptions = {}) {
        this.#probe = probe;
        this.#onRecover = opts.onRecover;
    }

    start(): void {
        if (this.#started) return;
        this.#started = true;
        window.addEventListener("online", this.#onWake);
        document.addEventListener("visibilitychange", this.#onWake);
        void this.checkNow();
    }

    stop(): void {
        this.#started = false;
        clearTimeout(this.#timer);
        this.#timer = undefined;
        window.removeEventListener("online", this.#onWake);
        document.removeEventListener("visibilitychange", this.#onWake);
    }

    /**
     * Another request on the screen found the server unreachable (a sign-in attempt, say): show it
     * and start retrying, the same as if the probe itself had failed.
     */
    markUnreachable(): void {
        if (!this.#started || this.status === "unreachable") return;
        this.status = "unreachable";
        this.#attempt = 0;
        this.#scheduleRetry();
    }

    /** Runs the probe now (calls made while one is in flight share it). Resolves to whether it answered. */
    checkNow(): Promise<boolean> {
        if (this.#inflight) return this.#inflight;
        clearTimeout(this.#timer);
        this.#timer = undefined;
        this.checking = true;
        this.#inflight = this.#runProbe().finally(() => {
            this.checking = false;
            this.#inflight = null;
        });
        return this.#inflight;
    }

    async #runProbe(): Promise<boolean> {
        try {
            await this.#probe();
        } catch {
            if (this.#started) {
                this.status = "unreachable";
                this.#scheduleRetry();
            }
            return false;
        }
        if (this.#started) {
            const recovered = this.status === "unreachable";
            this.status = "reachable";
            this.#attempt = 0;
            if (recovered) this.#onRecover?.();
        }
        return true;
    }

    #scheduleRetry(): void {
        clearTimeout(this.#timer);
        this.#timer = undefined;
        // A hidden tab waits for `visibilitychange` instead of polling in the background.
        if (!this.#started || document.visibilityState === "hidden") return;
        const delay = RETRY_DELAYS_MS[Math.min(this.#attempt, RETRY_DELAYS_MS.length - 1)];
        this.#attempt += 1;
        this.#timer = setTimeout(() => void this.checkNow(), delay);
    }

    #onWake = (): void => {
        if (this.status !== "unreachable" || document.visibilityState === "hidden") return;
        void this.checkNow();
    };
}
