/**
 * Whether the server collects analytics: the per-user daily-active row and the per-route, sign-in
 * and quota counters. `ANALYTICS_DISABLED=1` turns all of it off; the retention sweep keeps running
 * either way, so rows collected before the switch still expire. Read on every call — the one place
 * the switch is checked.
 */
export function isAnalyticsEnabled(): boolean {
    return process.env.ANALYTICS_DISABLED !== "1";
}

/** The in-process flush interval for the traffic, latency and auth counters. */
export const ANALYTICS_FLUSH_INTERVAL_MS = Number(
    process.env.ANALYTICS_FLUSH_INTERVAL_MS ?? 60_000,
);

/** The retention of the working DAU table (days). */
export const ANALYTICS_DAU_RETENTION_DAYS = Number(process.env.ANALYTICS_DAU_RETENTION_DAYS ?? 38);

/** The retention of the aggregate tables (days) — ~24 months. */
export const ANALYTICS_AGGREGATE_RETENTION_DAYS = Number(
    process.env.ANALYTICS_AGGREGATE_RETENTION_DAYS ?? 730,
);

/** The minimum number of accounts in a tier before percentiles are shown. */
export const ANALYTICS_STORAGE_TIER_MIN_SAMPLE = Number(
    process.env.ANALYTICS_STORAGE_TIER_MIN_SAMPLE ?? 10,
);

/** The UTC hour:minute at which the daily job may start (once the previous day has closed). */
export const ANALYTICS_DAILY_JOB_UTC_HOUR = Number(process.env.ANALYTICS_DAILY_JOB_UTC_HOUR ?? 0);
export const ANALYTICS_DAILY_JOB_UTC_MINUTE = Number(
    process.env.ANALYTICS_DAILY_JOB_UTC_MINUTE ?? 15,
);
