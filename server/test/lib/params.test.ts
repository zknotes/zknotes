// Saas spec 156 (package G): the query-parameter clamp that keeps garbage out of SQL.
import { describe, expect, test } from "bun:test";
import { parsePositiveIntParam } from "../../src/lib/params";

const opts = { defaultValue: 50, min: 1, max: 200 };

describe("parsePositiveIntParam", () => {
    test("absent or non-numeric input falls back to the default", () => {
        expect(parsePositiveIntParam(undefined, opts)).toBe(50);
        expect(parsePositiveIntParam("", opts)).toBe(50);
        expect(parsePositiveIntParam("abc", opts)).toBe(50);
    });

    test("numbers are clamped into [min, max]; a leading number is enough", () => {
        expect(parsePositiveIntParam("9999", opts)).toBe(200);
        expect(parsePositiveIntParam("-5", opts)).toBe(1);
        expect(parsePositiveIntParam("0", opts)).toBe(1);
        expect(parsePositiveIntParam("25", opts)).toBe(25);
        expect(parsePositiveIntParam("25px", opts)).toBe(25);
    });
});
