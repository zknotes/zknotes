// Saas spec 156 (package G): the "immortal trash" defence had no direct test.
import { describe, expect, test } from "bun:test";
import { clampDeletedAt } from "../../src/lib/time";

const NOW = 1_800_000_000;

describe("clampDeletedAt", () => {
    test("a timestamp in the future is pulled back to now; the past is left alone", () => {
        expect(clampDeletedAt(NOW + 3600, NOW)).toBe(NOW);
        expect(clampDeletedAt(NOW - 3600, NOW)).toBe(NOW - 3600);
        expect(clampDeletedAt(NOW, NOW)).toBe(NOW);
    });

    test("no value means no trash timestamp", () => {
        expect(clampDeletedAt(null, NOW)).toBeNull();
        expect(clampDeletedAt(undefined, NOW)).toBeNull();
    });
});
