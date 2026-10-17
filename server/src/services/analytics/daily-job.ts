import { count, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import {
    analyticsActiveUsersDaily,
    analyticsAuthDaily,
    analyticsDailyActiveUsers,
    analyticsRouteDaily,
    analyticsStorageQuotaDaily,
    users,
} from "../../db/schema";
import {
    ANALYTICS_AGGREGATE_RETENTION_DAYS,
    ANALYTICS_DAU_RETENTION_DAYS,
    ANALYTICS_STORAGE_TIER_MIN_SAMPLE,
} from "./constants";
import { utcDayStartSec, yesterdayUtcDayStartSec } from "./day";
import { flushAnalyticsCounters } from "./flush";

const SECONDS_PER_DAY = 86_400;

/** Quota utilisation as a percentage (rounded to a whole percent). */
function usagePct(used: number, quota: number): number {
    if (quota <= 0) return 0;
    return Math.round((used / quota) * 100);
}

/**
 * The daily batch job — it runs after 00:15 UTC for the previous day.
 * Order: aggregate yesterday → clean up older rows.
 */
export async function runAnalyticsDailyJob(targetDay?: number): Promise<void> {
    await flushAnalyticsCounters();

    const day = targetDay ?? yesterdayUtcDayStartSec();
    const mauWindowStart = day - 29 * SECONDS_PER_DAY;

    const [dauRow] = await db
        .select({ c: count() })
        .from(analyticsDailyActiveUsers)
        .where(eq(analyticsDailyActiveUsers.day, day));

    const [mauRow] = await db
        .select({ c: sql<number>`count(distinct ${analyticsDailyActiveUsers.user_id})::int` })
        .from(analyticsDailyActiveUsers)
        .where(
            sql`${analyticsDailyActiveUsers.day} >= ${mauWindowStart} AND ${analyticsDailyActiveUsers.day} <= ${day}`,
        );

    const [accountsRow] = await db.select({ c: count() }).from(users);

    const dau = dauRow?.c ?? 0;
    const mau = mauRow?.c ?? 0;
    const totalAccounts = accountsRow?.c ?? 0;

    await db
        .insert(analyticsActiveUsersDaily)
        .values({ day, dau, mau, total_accounts: totalAccounts })
        .onConflictDoUpdate({
            target: analyticsActiveUsersDaily.day,
            set: { dau, mau, total_accounts: totalAccounts },
        });

    // The storage/quota snapshot per tier
    const tierRows = await db
        .select({
            storage_quota: users.storage_quota,
            account_count: sql<number>`count(*)::int`,
            avg_usage_pct: sql<number>`round(avg(100.0 * ${users.storage_used} / nullif(${users.storage_quota}, 0)))::int`,
            p50_usage_pct: sql<
                number | null
            >`round((percentile_cont(0.5) within group (order by 100.0 * ${users.storage_used} / nullif(${users.storage_quota}, 0)))::numeric)::int`,
            p95_usage_pct: sql<
                number | null
            >`round((percentile_cont(0.95) within group (order by 100.0 * ${users.storage_used} / nullif(${users.storage_quota}, 0)))::numeric)::int`,
        })
        .from(users)
        .groupBy(users.storage_quota);

    for (const tier of tierRows) {
        const n = tier.account_count;
        const hidePercentiles = n < ANALYTICS_STORAGE_TIER_MIN_SAMPLE;
        await db
            .insert(analyticsStorageQuotaDaily)
            .values({
                day,
                storage_quota: tier.storage_quota,
                account_count: n,
                avg_usage_pct: tier.avg_usage_pct ?? 0,
                p50_usage_pct: hidePercentiles ? null : (tier.p50_usage_pct ?? null),
                p95_usage_pct: hidePercentiles ? null : (tier.p95_usage_pct ?? null),
            })
            .onConflictDoUpdate({
                target: [analyticsStorageQuotaDaily.day, analyticsStorageQuotaDaily.storage_quota],
                set: {
                    account_count: n,
                    avg_usage_pct: tier.avg_usage_pct ?? 0,
                    p50_usage_pct: hidePercentiles ? null : (tier.p50_usage_pct ?? null),
                    p95_usage_pct: hidePercentiles ? null : (tier.p95_usage_pct ?? null),
                },
            });
    }

    // Cleanup — only after yesterday has been aggregated
    await runAnalyticsRetention();
}

/**
 * Delete analytics rows past their retention: the per-user daily-active rows after
 * ANALYTICS_DAU_RETENTION_DAYS, the aggregates after ANALYTICS_AGGREGATE_RETENTION_DAYS. It runs
 * with analytics disabled too (scheduler.ts), so rows collected before the switch still expire.
 */
export async function runAnalyticsRetention(): Promise<void> {
    const dauCutoff = utcDayStartSec() - ANALYTICS_DAU_RETENTION_DAYS * SECONDS_PER_DAY;
    await db.delete(analyticsDailyActiveUsers).where(lt(analyticsDailyActiveUsers.day, dauCutoff));

    const aggregateCutoff = utcDayStartSec() - ANALYTICS_AGGREGATE_RETENTION_DAYS * SECONDS_PER_DAY;
    await db
        .delete(analyticsActiveUsersDaily)
        .where(lt(analyticsActiveUsersDaily.day, aggregateCutoff));
    await db.delete(analyticsRouteDaily).where(lt(analyticsRouteDaily.day, aggregateCutoff));
    await db.delete(analyticsAuthDaily).where(lt(analyticsAuthDaily.day, aggregateCutoff));
    await db
        .delete(analyticsStorageQuotaDaily)
        .where(lt(analyticsStorageQuotaDaily.day, aggregateCutoff));
}

/** Whether the daily job has already processed this day. */
export async function isDayProcessed(day: number): Promise<boolean> {
    const [row] = await db
        .select({ day: analyticsActiveUsersDaily.day })
        .from(analyticsActiveUsersDaily)
        .where(eq(analyticsActiveUsersDaily.day, day))
        .limit(1);
    return row !== undefined;
}
