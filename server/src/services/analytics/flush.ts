import { sql } from "drizzle-orm";
import { db } from "../../db";
import { analyticsAuthDaily, analyticsRouteDaily } from "../../db/schema";
import { takeFlushSnapshot } from "./collector";

/** Flushes the in-memory counters into PostgreSQL — an atomic increment, not an overwrite. */
export async function flushAnalyticsCounters(): Promise<void> {
    const { routes, auth } = takeFlushSnapshot();

    for (const row of routes) {
        await db
            .insert(analyticsRouteDaily)
            .values({
                day: row.day,
                method: row.method,
                route: row.route,
                status_class: row.statusClass,
                request_count: row.count,
                latency_sum_ms: row.latencySumMs,
                latency_max_ms: row.latencyMaxMs,
            })
            .onConflictDoUpdate({
                target: [
                    analyticsRouteDaily.day,
                    analyticsRouteDaily.method,
                    analyticsRouteDaily.route,
                    analyticsRouteDaily.status_class,
                ],
                set: {
                    request_count: sql`${analyticsRouteDaily.request_count} + ${row.count}`,
                    latency_sum_ms: sql`${analyticsRouteDaily.latency_sum_ms} + ${row.latencySumMs}`,
                    latency_max_ms: sql`GREATEST(${analyticsRouteDaily.latency_max_ms}, ${row.latencyMaxMs})`,
                },
            });
    }

    for (const row of auth) {
        await db
            .insert(analyticsAuthDaily)
            .values({
                day: row.day,
                registrations: row.registrations,
                login_success: row.loginSuccess,
                login_failure: row.loginFailure,
            })
            .onConflictDoUpdate({
                target: analyticsAuthDaily.day,
                set: {
                    registrations: sql`${analyticsAuthDaily.registrations} + ${row.registrations}`,
                    login_success: sql`${analyticsAuthDaily.login_success} + ${row.loginSuccess}`,
                    login_failure: sql`${analyticsAuthDaily.login_failure} + ${row.loginFailure}`,
                },
            });
    }
}
