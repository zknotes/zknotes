import { nowSec } from "../../lib/time";
import { ANALYTICS_DAILY_JOB_UTC_HOUR, ANALYTICS_DAILY_JOB_UTC_MINUTE } from "./constants";

const SECONDS_PER_DAY = 86_400;

/** UTC midnight for a given timestamp (epoch seconds). */
export function utcDayStartSec(ts: number = nowSec()): number {
    return Math.floor(ts / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

/** Yesterday's UTC day (epoch midnight). */
export function yesterdayUtcDayStartSec(ts: number = nowSec()): number {
    return utcDayStartSec(ts) - SECONDS_PER_DAY;
}

/** Whether yesterday's daily-job slot has passed. */
export function isPastDailyJobSlot(ts: number = nowSec()): boolean {
    const d = new Date(ts * 1000);
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    if (hour > ANALYTICS_DAILY_JOB_UTC_HOUR) return true;
    if (hour === ANALYTICS_DAILY_JOB_UTC_HOUR && minute >= ANALYTICS_DAILY_JOB_UTC_MINUTE)
        return true;
    return false;
}
