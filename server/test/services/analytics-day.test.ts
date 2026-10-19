// Saas spec 156 (package G): the daily-job slot boundary and the status class buckets.
import { describe, expect, test } from "bun:test";
import {
    ANALYTICS_DAILY_JOB_UTC_HOUR,
    ANALYTICS_DAILY_JOB_UTC_MINUTE,
} from "../../src/services/analytics/constants";
import {
    isPastDailyJobSlot,
    utcDayStartSec,
    yesterdayUtcDayStartSec,
} from "../../src/services/analytics/day";
import { statusClass } from "../../src/services/analytics/whitelist";

// 2026-03-05T00:00:00Z
const MIDNIGHT = Date.UTC(2026, 2, 5) / 1000;
const slot = MIDNIGHT + ANALYTICS_DAILY_JOB_UTC_HOUR * 3600 + ANALYTICS_DAILY_JOB_UTC_MINUTE * 60;

describe("daily job slot", () => {
    test("is past exactly at the slot, not one second earlier", () => {
        expect(isPastDailyJobSlot(slot - 1)).toBe(false);
        expect(isPastDailyJobSlot(slot)).toBe(true);
        expect(isPastDailyJobSlot(MIDNIGHT + 23 * 3600 + 59 * 60)).toBe(true);
    });

    test("UTC day arithmetic", () => {
        expect(utcDayStartSec(MIDNIGHT + 5000)).toBe(MIDNIGHT);
        expect(yesterdayUtcDayStartSec(MIDNIGHT + 5000)).toBe(MIDNIGHT - 86_400);
    });
});

describe("statusClass", () => {
    test("buckets 2xx, 4xx and 5xx; redirects and informational answers are not counted", () => {
        expect(statusClass(200)).toBe("2xx");
        expect(statusClass(299)).toBe("2xx");
        expect(statusClass(301)).toBeNull();
        expect(statusClass(199)).toBeNull();
        expect(statusClass(404)).toBe("4xx");
        expect(statusClass(500)).toBe("5xx");
        expect(statusClass(599)).toBe("5xx");
    });
});
