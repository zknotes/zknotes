import { describe, expect, it } from "vitest";
import { mutationRetryAt } from "./outbox";

// Saas spec 156 (package G): the one definition of the push backoff that the drain, the retry timer
// and the Sync panel all read — deterministic per (id, attempt), capped, in whole milliseconds.
const at = (id: string, attempt_count: number, attempted_at = 1_000_000) => ({
    id,
    attempt_count,
    attempted_at,
});

describe("mutationRetryAt", () => {
    it("a fresh mutation is due at once", () => {
        expect(mutationRetryAt(at("a", 0))).toBe(0);
    });

    it("the first retry waits about a second, jittered within ±20 %, as a whole number", () => {
        const due = mutationRetryAt(at("a", 1));
        expect(due - 1_000_000).toBeGreaterThanOrEqual(800);
        expect(due - 1_000_000).toBeLessThan(1200);
        expect(Number.isInteger(due)).toBe(true);
    });

    it("is deterministic for the same id and attempt, and differs across ids", () => {
        expect(mutationRetryAt(at("a", 2))).toBe(mutationRetryAt(at("a", 2)));
        const spread = new Set(["a", "b", "c", "d", "e"].map((id) => mutationRetryAt(at(id, 2))));
        expect(spread.size).toBeGreaterThan(1);
    });

    it("caps at five minutes, jitter included", () => {
        const due = mutationRetryAt(at("a", 99));
        expect(due - 1_000_000).toBeLessThanOrEqual(5 * 60_000 * 1.2);
        expect(due - 1_000_000).toBeGreaterThanOrEqual(5 * 60_000 * 0.8);
    });
});
