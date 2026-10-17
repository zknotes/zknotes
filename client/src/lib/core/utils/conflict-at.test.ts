import { describe, expect, it } from "vitest";
import { normalizeConflictAt } from "./conflict-at";

describe("normalizeConflictAt", () => {
    it("leaves unix seconds unchanged", () => {
        expect(normalizeConflictAt(1_700_000_000)).toBe(1_700_000_000);
    });

    it("converts milliseconds to seconds", () => {
        expect(normalizeConflictAt(1_700_000_000_123)).toBe(1_700_000_000);
    });
});
