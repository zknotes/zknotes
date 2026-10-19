import { afterEach, describe, expect, it, vi } from "vitest";
import { humanSize, humanSizeShort, relativeTime, trashRetentionLabel } from "./format";

// Saas spec 156 (package G): these render on every files/trash/recent row and had no test.
afterEach(() => vi.useRealTimers());

describe("humanSize", () => {
    it("picks the unit and the precision by magnitude; nothing is a dash", () => {
        expect(humanSize(null)).toBe("—");
        expect(humanSize(undefined)).toBe("—");
        expect(humanSize(0)).toBe("0 B");
        expect(humanSize(1023)).toBe("1023 B");
        expect(humanSize(1024)).toBe("1.0 KB");
        expect(humanSize(10 * 1024)).toBe("10 KB");
        expect(humanSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
        expect(humanSize(20 * 1024 * 1024)).toBe("20 MB");
    });
});

describe("humanSizeShort", () => {
    it("has no byte level and adds GB", () => {
        expect(humanSizeShort(512)).toBe("1 KB");
        expect(humanSizeShort(1024 * 1024)).toBe("1.0 MB");
        expect(humanSizeShort(1024 * 1024 * 1024)).toBe("1.0 GB");
    });
});

describe("relativeTime", () => {
    it("rounds to the nearest unit and never says 0", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_800_000_000_000));
        const now = 1_800_000_000;
        expect(relativeTime(0)).toBe("now");
        expect(relativeTime(now)).toBe("1s ago");
        expect(relativeTime(now - 59)).toBe("59s ago");
        expect(relativeTime(now - 90)).toBe("2m ago");
        expect(relativeTime(now - 3 * 3600)).toBe("3h ago");
        expect(relativeTime(now - 2 * 86_400)).toBe("2d ago");
    });
});

describe("trashRetentionLabel", () => {
    it("counts whole days down to a floor of one, and is null without a deletion time", () => {
        const now = 1_800_000_000;
        expect(trashRetentionLabel(undefined, now)).toBeNull();
        expect(trashRetentionLabel(now - 3600, now)?.daysLeftText).toBe("30 days left");
        expect(trashRetentionLabel(now - 29 * 86_400, now)?.daysLeftText).toBe("1 day left");
        expect(trashRetentionLabel(now - 31 * 86_400, now)?.daysLeftText).toBe("1 day left");
    });
});
