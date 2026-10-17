import { describe, expect, it } from "vitest";
import { formatWithDatePattern } from "./date-pattern";

describe("formatWithDatePattern", () => {
    const ts = 1_704_067_200; // 2024-01-01 00:00:00 UTC

    it("formats DD/MM/YYYY HH:mm", () => {
        const out = formatWithDatePattern(ts, "DD/MM/YYYY HH:mm", "24h", "UTC");
        expect(out).toMatch(/01\/01\/2024 00:00/);
    });

    it("formats custom dotted pattern", () => {
        const out = formatWithDatePattern(ts, "YYYY.MM.DD", "24h", "UTC");
        expect(out).toBe("2024.01.01");
    });

    it("formats DD.MM.YYYY preset pattern", () => {
        const out = formatWithDatePattern(ts, "DD.MM.YYYY", "24h", "UTC");
        expect(out).toBe("01.01.2024");
    });

    it("falls back to default when pattern is empty", () => {
        const out = formatWithDatePattern(ts, "   ", "24h", "UTC");
        expect(out).toContain("/");
    });
});
