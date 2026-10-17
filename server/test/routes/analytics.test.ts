import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import {
    analyticsActiveUsersDaily,
    analyticsAuthDaily,
    analyticsDailyActiveUsers,
    analyticsRouteDaily,
} from "../../src/db/schema";
import {
    recordLoginFailure,
    recordLoginSuccess,
    recordRegistration,
    resetAnalyticsCollectorForTest,
} from "../../src/services/analytics/collector";
import { runAnalyticsDailyJob } from "../../src/services/analytics/daily-job";
import { utcDayStartSec, yesterdayUtcDayStartSec } from "../../src/services/analytics/day";
import { flushAnalyticsCounters } from "../../src/services/analytics/flush";
import {
    ANALYTICS_ROUTE_WHITELIST,
    isAnalyticsRoute,
} from "../../src/services/analytics/whitelist";
import { createTestUser, getUserIdByEmail, resetDb } from "../helpers";

let app: FastifyInstance;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    await resetDb();
    resetAnalyticsCollectorForTest();
});

describe("server-side analytics", () => {
    test("onResponse records a whitelisted route and the flush does an atomic increment", async () => {
        const { cookie } = await createTestUser(app);

        await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });

        await flushAnalyticsCounters();

        const day = utcDayStartSec();
        const [row] = await db
            .select()
            .from(analyticsRouteDaily)
            .where(
                and(
                    eq(analyticsRouteDaily.day, day),
                    eq(analyticsRouteDaily.method, "GET"),
                    eq(analyticsRouteDaily.route, "/items"),
                ),
            );

        expect(row?.method).toBe("GET");
        expect(row?.route).toBe("/items");
        expect(row?.status_class).toBe("2xx");
        expect(row?.request_count).toBe(1);
    });

    test("DAU dedup — two requests from the same user = one row", async () => {
        const { cookie } = await createTestUser(app);
        const headers = { cookie };

        await app.inject({ method: "GET", url: "/items?limit=1000", headers });
        await app.inject({ method: "GET", url: "/items?limit=1000", headers });
        await flushAnalyticsCounters();

        const day = utcDayStartSec();
        const rows = await db
            .select()
            .from(analyticsDailyActiveUsers)
            .where(eq(analyticsDailyActiveUsers.day, day));

        expect(rows.length).toBe(1);
    });

    test("the auth counters flush registrations and sign-ins", async () => {
        recordRegistration();
        recordLoginSuccess();
        recordLoginFailure();
        await flushAnalyticsCounters();

        const day = utcDayStartSec();
        const [row] = await db
            .select()
            .from(analyticsAuthDaily)
            .where(eq(analyticsAuthDaily.day, day));

        expect(row?.registrations).toBe(1);
        expect(row?.login_success).toBe(1);
        expect(row?.login_failure).toBe(1);
    });

    test("the daily job aggregates yesterday's DAU/MAU and total_accounts", async () => {
        await createTestUser(app, { email: "dau@example.com" });
        const yesterday = yesterdayUtcDayStartSec();
        const userId = await getUserIdByEmail("dau@example.com");
        if (!userId) throw new Error("user missing");

        await db.insert(analyticsDailyActiveUsers).values({
            day: yesterday,
            user_id: userId,
        });

        await runAnalyticsDailyJob(yesterday);

        const [agg] = await db
            .select()
            .from(analyticsActiveUsersDaily)
            .where(eq(analyticsActiveUsersDaily.day, yesterday));

        expect(agg?.dau).toBe(1);
        expect(agg?.mau).toBe(1);
        expect(agg?.total_accounts).toBe(1);
    });

    // The core covers the **measurement**: whitelisted routes, DAU dedup, the auth counters and the
    // daily aggregate.
});

describe("registrations and the route whitelist", () => {
    const vaultBody = (email: string) => ({
        email,
        auth_key: "A".repeat(44),
        kdf_salt: "B".repeat(24),
        kdf_params: { m: 1024, t: 1, p: 1 },
        encrypted_vault_key: "A".repeat(64),
        vault_key_nonce: "B".repeat(32),
    });

    async function registrationsToday(): Promise<number> {
        await flushAnalyticsCounters();
        const [row] = await db
            .select()
            .from(analyticsAuthDaily)
            .where(eq(analyticsAuthDaily.day, utcDayStartSec()));
        return row?.registrations ?? 0;
    }

    test("a vault really created counts once, the same address again does not", async () => {
        const first = await app.inject({
            method: "POST",
            url: "/vault",
            payload: vaultBody("reg@example.com"),
        });
        expect(first.statusCode).toBe(201);
        // The anti-enumeration branch answers 201 too, but creates nothing.
        const again = await app.inject({
            method: "POST",
            url: "/vault",
            payload: vaultBody("reg@example.com"),
        });
        expect(again.statusCode).toBe(201);

        expect(await registrationsToday()).toBe(1);
    });

    test("/vault and the seven restore routes are counted, a dead route and /instance-config are not", async () => {
        for (const route of [
            "/vault",
            "/restore/sessions",
            "/restore/sessions/:id",
            "/restore/sessions/:id/items",
            "/restore/sessions/:id/ping",
            "/restore/sessions/:id/verify",
            "/restore/sessions/:id/commit",
            "/restore/sessions/:id/abort",
        ]) {
            expect(isAnalyticsRoute(route)).toBe(true);
        }
        expect(isAnalyticsRoute("/auth/register")).toBe(false);
        expect(isAnalyticsRoute("/instance-config")).toBe(false);

        const { cookie } = await createTestUser(app);
        const open = await app.inject({
            method: "POST",
            url: "/restore/sessions",
            headers: { cookie },
            payload: {
                backup_hash: "a".repeat(64),
                manifest: [{ id: uuidv7(), type: "note", parent_id: null, byte_size: 16 }],
                mode: "skip_existing",
            },
        });
        expect(open.statusCode).toBe(201);
        await flushAnalyticsCounters();

        const [row] = await db
            .select()
            .from(analyticsRouteDaily)
            .where(
                and(
                    eq(analyticsRouteDaily.day, utcDayStartSec()),
                    eq(analyticsRouteDaily.method, "POST"),
                    eq(analyticsRouteDaily.route, "/restore/sessions"),
                ),
            );
        expect(row?.status_class).toBe("2xx");
        expect(row?.request_count).toBe(1);
    });

    // `/auth/register` stayed on the list for months after the route was gone; nothing noticed.
    test("every whitelisted route exists in the app", () => {
        const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
        const dead = [...ANALYTICS_ROUTE_WHITELIST].filter(
            (url) => !methods.some((method) => app.hasRoute({ method, url })),
        );
        expect(dead).toEqual([]);
    });
});
