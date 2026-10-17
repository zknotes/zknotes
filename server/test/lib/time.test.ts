import { afterEach, describe, expect, test } from "bun:test";
import { issuedWatermarkMs, parseTimestampParam } from "../../src/lib/time";

describe("parseTimestampParam", () => {
    test("milliseconds → seconds (floor)", () => {
        expect(parseTimestampParam("1718200000000")).toBe(1718200000);
        expect(parseTimestampParam("1718200000999")).toBe(1718200000);
    });

    test("undefined → null", () => {
        expect(parseTimestampParam(undefined)).toBeNull();
    });

    test("an empty string → null", () => {
        expect(parseTimestampParam("")).toBeNull();
    });

    test("an invalid number → null (a NaN used to slip silently into the query)", () => {
        expect(parseTimestampParam("abc")).toBeNull();
        expect(parseTimestampParam("--5")).toBeNull();
    });

    test("a leading number with a tail parses like parseInt (radix 10)", () => {
        // parseInt semantics: "123abc" → 123ms → 0s
        expect(parseTimestampParam("123abc")).toBe(0);
        expect(parseTimestampParam("1718200000000.7")).toBe(1718200000);
    });

    test("zero and negative values", () => {
        expect(parseTimestampParam("0")).toBe(0);
        expect(parseTimestampParam("-5000")).toBe(-5);
    });
});

describe("issuedWatermarkMs", () => {
    afterEach(() => {
        delete process.env.SYNC_WATERMARK_SAFETY_MS;
    });

    test("subtracts the safety window taken from the environment", () => {
        process.env.SYNC_WATERMARK_SAFETY_MS = "5000";
        expect(issuedWatermarkMs(12_000)).toBe(7000);
    });

    test("clamps to 0 when captured is smaller than the window", () => {
        process.env.SYNC_WATERMARK_SAFETY_MS = "5000";
        expect(issuedWatermarkMs(1000)).toBe(0);
    });

    test("defaults to 30 s when the environment does not set it", () => {
        expect(issuedWatermarkMs(40_000)).toBe(10_000);
    });

    test("an invalid or negative env value falls back to the default; zero is a legitimate rollback", () => {
        process.env.SYNC_WATERMARK_SAFETY_MS = "nope";
        expect(issuedWatermarkMs(40_000)).toBe(10_000);
        process.env.SYNC_WATERMARK_SAFETY_MS = "-1";
        expect(issuedWatermarkMs(40_000)).toBe(10_000);
        process.env.SYNC_WATERMARK_SAFETY_MS = "0";
        expect(issuedWatermarkMs(40_000)).toBe(40_000);
    });
});
