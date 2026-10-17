import { describe, expect, it } from "vitest";
import { effectiveTrashedBytes } from "./storage-display";

describe("effectiveTrashedBytes", () => {
    it("uses the local bytes when the soft delete is ahead of the API (local > api)", () => {
        expect(effectiveTrashedBytes(0, 12_000)).toBe(12_000);
    });

    it("does not hold on to a stale API figure after an empty/purge (api > local → local)", () => {
        // Before: Math.max(5_000_000, 0) = 5_000_000 — the bar stayed full until Refresh was clicked
        expect(effectiveTrashedBytes(5_000_000, 0)).toBe(0);
    });

    it("when they agree, it returns that value", () => {
        expect(effectiveTrashedBytes(1024, 1024)).toBe(1024);
    });
});
