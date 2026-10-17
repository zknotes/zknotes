import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db";
import { analyticsDailyActiveUsers } from "../../db/schema";
import { isAnalyticsEnabled } from "./constants";
import { utcDayStartSec } from "./day";
import { isAnalyticsRoute, statusClass } from "./whitelist";

type RouteCounter = {
    count: number;
    latencySumMs: number;
    latencyMaxMs: number;
};

type RouteKey = string;

function routeKey(method: string, route: string, status: "2xx" | "4xx" | "5xx"): RouteKey {
    return `${method}\0${route}\0${status}`;
}

/** In-memory state per UTC day — flushed to PostgreSQL periodically. */
const routeCounters = new Map<number, Map<RouteKey, RouteCounter>>();
const authCounters = new Map<
    number,
    { registrations: number; loginSuccess: number; loginFailure: number }
>();

/** DAU dedup: day → Set of user_id (it holds the current and the previous day). */
const dauSeen = new Map<number, Set<string>>();

function getRouteMap(day: number): Map<RouteKey, RouteCounter> {
    let m = routeCounters.get(day);
    if (!m) {
        m = new Map();
        routeCounters.set(day, m);
    }
    return m;
}

function getAuthMap(day: number) {
    let m = authCounters.get(day);
    if (!m) {
        m = { registrations: 0, loginSuccess: 0, loginFailure: 0 };
        authCounters.set(day, m);
    }
    return m;
}

function pruneOldDays(currentDay: number): void {
    const keep = new Set([currentDay, currentDay - 86_400]);
    for (const day of routeCounters.keys()) {
        if (!keep.has(day)) routeCounters.delete(day);
    }
    for (const day of authCounters.keys()) {
        if (!keep.has(day)) authCounters.delete(day);
    }
    for (const day of dauSeen.keys()) {
        if (!keep.has(day)) dauSeen.delete(day);
    }
}

function recordRouteMetrics(request: FastifyRequest, reply: FastifyReply, day: number): void {
    const route = request.routeOptions?.url;
    if (!isAnalyticsRoute(route)) return;

    const sc = statusClass(reply.statusCode);
    if (!sc) return;

    const key = routeKey(request.method, route, sc);
    const map = getRouteMap(day);
    const entry = map.get(key) ?? { count: 0, latencySumMs: 0, latencyMaxMs: 0 };
    const duration = Math.max(0, Math.round(reply.elapsedTime ?? 0));
    entry.count += 1;
    entry.latencySumMs += duration;
    entry.latencyMaxMs = Math.max(entry.latencyMaxMs, duration);
    map.set(key, entry);
}

export async function recordRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const day = utcDayStartSec();
    pruneOldDays(day);
    recordRouteMetrics(request, reply, day);

    const userId = request.user_id;
    if (userId) {
        await recordActiveUser(userId, day);
    }
}

async function recordActiveUser(userId: string, day: number): Promise<void> {
    let seen = dauSeen.get(day);
    if (!seen) {
        seen = new Set();
        dauSeen.set(day, seen);
    }
    if (seen.has(userId)) return;
    seen.add(userId);

    try {
        await db
            .insert(analyticsDailyActiveUsers)
            .values({ day, user_id: userId })
            .onConflictDoNothing();
    } catch {
        // Analytics must never affect the user's response.
    }
}

// The auth routes call these unconditionally; with analytics off they record nothing, not even in
// memory.
export function recordRegistration(): void {
    if (!isAnalyticsEnabled()) return;
    const day = utcDayStartSec();
    pruneOldDays(day);
    getAuthMap(day).registrations += 1;
}

export function recordLoginSuccess(): void {
    if (!isAnalyticsEnabled()) return;
    const day = utcDayStartSec();
    pruneOldDays(day);
    getAuthMap(day).loginSuccess += 1;
}

export function recordLoginFailure(): void {
    if (!isAnalyticsEnabled()) return;
    const day = utcDayStartSec();
    pruneOldDays(day);
    getAuthMap(day).loginFailure += 1;
}

/** A snapshot of the in-memory counters for the flush — it empties the source maps once taken. */
export function takeFlushSnapshot(): {
    routes: Array<{
        day: number;
        method: string;
        route: string;
        statusClass: "2xx" | "4xx" | "5xx";
        count: number;
        latencySumMs: number;
        latencyMaxMs: number;
    }>;
    auth: Array<{
        day: number;
        registrations: number;
        loginSuccess: number;
        loginFailure: number;
    }>;
} {
    const routes: Array<{
        day: number;
        method: string;
        route: string;
        statusClass: "2xx" | "4xx" | "5xx";
        count: number;
        latencySumMs: number;
        latencyMaxMs: number;
    }> = [];

    for (const [day, map] of routeCounters) {
        for (const [key, val] of map) {
            const [method, route, statusClassVal] = key.split("\0") as [
                string,
                string,
                "2xx" | "4xx" | "5xx",
            ];
            if (val.count === 0) continue;
            routes.push({
                day,
                method,
                route,
                statusClass: statusClassVal,
                count: val.count,
                latencySumMs: val.latencySumMs,
                latencyMaxMs: val.latencyMaxMs,
            });
        }
        map.clear();
    }

    const auth: Array<{
        day: number;
        registrations: number;
        loginSuccess: number;
        loginFailure: number;
    }> = [];
    for (const [day, val] of authCounters) {
        if (val.registrations === 0 && val.loginSuccess === 0 && val.loginFailure === 0) continue;
        auth.push({
            day,
            registrations: val.registrations,
            loginSuccess: val.loginSuccess,
            loginFailure: val.loginFailure,
        });
        authCounters.set(day, { registrations: 0, loginSuccess: 0, loginFailure: 0 });
    }

    return { routes, auth };
}

/** A test helper — it resets the in-memory state. */
export function resetAnalyticsCollectorForTest(): void {
    routeCounters.clear();
    authCounters.clear();
    dauSeen.clear();
}
