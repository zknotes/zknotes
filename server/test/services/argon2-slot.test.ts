import { describe, expect, test } from "bun:test";
import {
    Argon2BacklogError,
    getArgon2ActiveCount,
    getArgon2MaxConcurrent,
    getArgon2MaxWaiters,
    getArgon2WaiterCount,
    withArgon2Slot,
} from "../../src/services/auth-service";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Argon2 concurrency slot", () => {
    test("withArgon2Slot never exceeds ARGON2_MAX_CONCURRENT active workers", async () => {
        const max = getArgon2MaxConcurrent();
        expect(max).toBeGreaterThan(0);

        let peak = 0;
        const n = max + 4;
        await Promise.all(
            Array.from({ length: n }, () =>
                withArgon2Slot(async () => {
                    peak = Math.max(peak, getArgon2ActiveCount());
                    await delay(30);
                }),
            ),
        );

        expect(peak).toBeLessThanOrEqual(max);
        expect(getArgon2ActiveCount()).toBe(0);
    });

    test("withArgon2Slot rejects once the waiter queue is full", async () => {
        const max = getArgon2MaxConcurrent();
        const maxWaiters = getArgon2MaxWaiters();
        expect(maxWaiters).toBeGreaterThan(0);

        const n = max + maxWaiters + 4;
        const results = await Promise.allSettled(
            Array.from({ length: n }, () =>
                withArgon2Slot(async () => {
                    await delay(30);
                }),
            ),
        );

        const rejected = results.filter((r) => r.status === "rejected");
        const fulfilled = results.filter((r) => r.status === "fulfilled");

        expect(fulfilled.length).toBe(max + maxWaiters);
        expect(rejected.length).toBe(4);
        expect(
            rejected.every(
                (r) => r.status === "rejected" && r.reason instanceof Argon2BacklogError,
            ),
        ).toBe(true);
        expect(getArgon2ActiveCount()).toBe(0);
        expect(getArgon2WaiterCount()).toBe(0);
    });
});
