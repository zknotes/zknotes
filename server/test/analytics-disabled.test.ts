// ANALYTICS_DISABLED=1 used to stop only the scheduler: the request hook stayed registered and kept
// writing a row per active user per day — and with the daily job off, nothing ever deleted them.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { db } from "../src/db";
import {
    analyticsAuthDaily,
    analyticsDailyActiveUsers,
    analyticsRouteDaily,
} from "../src/db/schema";
import {
    recordLoginFailure,
    recordLoginSuccess,
    recordRegistration,
    takeFlushSnapshot,
} from "../src/services/analytics/collector";
import { runAnalyticsRetention } from "../src/services/analytics/daily-job";
import { flushAnalyticsCounters } from "../src/services/analytics/flush";
import { utcDayStartSec } from "../src/services/analytics/day";
import { createTestUser, getUserIdByEmail, resetDb } from "./helpers";

const DAY = 86_400;

describe("ANALYTICS_DISABLED=1", () => {
    let app: FastifyInstance;
    let previous: string | undefined;

    beforeAll(async () => {
        previous = process.env.ANALYTICS_DISABLED;
        process.env.ANALYTICS_DISABLED = "1";
        app = await buildApp();
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        if (previous === undefined) delete process.env.ANALYTICS_DISABLED;
        else process.env.ANALYTICS_DISABLED = previous;
    });

    beforeEach(resetDb);

    test("an authenticated request records no active user", async () => {
        const { cookie } = await createTestUser(app);

        const res = await app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);

        expect(await db.select().from(analyticsDailyActiveUsers)).toEqual([]);
    });

    test("sign-in and registration counters stay empty, in memory as well", async () => {
        // Drop whatever earlier tests in this process counted while analytics was on.
        takeFlushSnapshot();
        recordRegistration();
        recordLoginSuccess();
        recordLoginFailure();
        // The flush writes whatever the counters hold, regardless of the switch.
        await flushAnalyticsCounters();

        expect(await db.select().from(analyticsAuthDaily)).toEqual([]);
    });
});

describe("analytics retention", () => {
    beforeEach(resetDb);

    test("deletes per-user rows past their retention and keeps recent ones", async () => {
        const app = await buildApp();
        await app.ready();
        const { email } = await createTestUser(app);
        await app.close();
        const userId = (await getUserIdByEmail(email)) as string;
        const today = utcDayStartSec();

        await db.insert(analyticsDailyActiveUsers).values([
            { day: today - 60 * DAY, user_id: userId },
            { day: today - 2 * DAY, user_id: userId },
        ]);
        await db.insert(analyticsRouteDaily).values([
            { day: today - 800 * DAY, method: "GET", route: "/items", status_class: "2xx" },
            { day: today - 2 * DAY, method: "GET", route: "/items", status_class: "2xx" },
        ]);

        await runAnalyticsRetention();

        const dau = await db.select().from(analyticsDailyActiveUsers);
        expect(dau.map((r) => r.day)).toEqual([today - 2 * DAY]);
        const routes = await db.select().from(analyticsRouteDaily);
        expect(routes.map((r) => r.day)).toEqual([today - 2 * DAY]);
    });
});
