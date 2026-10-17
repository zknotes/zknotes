import type { FastifyInstance } from "fastify";
import ms from "ms";
import { ANALYTICS_FLUSH_INTERVAL_MS, isAnalyticsEnabled } from "./constants";
import { isDayProcessed, runAnalyticsDailyJob, runAnalyticsRetention } from "./daily-job";
import { isPastDailyJobSlot, yesterdayUtcDayStartSec } from "./day";
import { flushAnalyticsCounters } from "./flush";

let flushBusy = false;
let dailyBusy = false;

async function tickFlush(fastify: FastifyInstance): Promise<void> {
    if (flushBusy) return;
    flushBusy = true;
    try {
        await flushAnalyticsCounters();
    } catch (e) {
        fastify.log.error(e, "analytics flush failed");
    } finally {
        flushBusy = false;
    }
}

/** What the daily tick reaches for — parameters so a test can stand a failing database in. */
export type DailyTickDeps = {
    isPastSlot?: () => boolean;
    isDayProcessed?: (day: number) => Promise<boolean>;
    runDailyJob?: (day: number) => Promise<unknown>;
};

/** Exported for tests; production reaches it only through `startAnalyticsScheduler`. */
export async function tickDaily(
    fastify: Pick<FastifyInstance, "log">,
    deps: DailyTickDeps = {},
): Promise<void> {
    const isPastSlot = deps.isPastSlot ?? isPastDailyJobSlot;
    const isProcessed = deps.isDayProcessed ?? isDayProcessed;
    const runDailyJob = deps.runDailyJob ?? runAnalyticsDailyJob;

    if (dailyBusy) return;
    if (!isPastSlot()) return;

    const yesterday = yesterdayUtcDayStartSec();
    dailyBusy = true;
    try {
        // Inside the try: the timers call this as `void tickDaily()`, so a rejection here (the
        // database not up yet) was unhandled and took the whole API process down with it.
        if (await isProcessed(yesterday)) return;
        await runDailyJob(yesterday);
        fastify.log.info(`[analytics] daily job completed for day=${yesterday}`);
    } catch (e) {
        fastify.log.error(e, "analytics daily job failed");
    } finally {
        dailyBusy = false;
    }
}

async function tickRetention(fastify: FastifyInstance): Promise<void> {
    try {
        await runAnalyticsRetention();
    } catch (e) {
        fastify.log.error(e, "analytics retention failed");
    }
}

export function startAnalyticsScheduler(fastify: FastifyInstance): void {
    if (!isAnalyticsEnabled()) {
        // Nothing is collected, but what was collected before the switch still has to expire.
        setTimeout(() => void tickRetention(fastify), ms("5s")).unref?.();
        setInterval(() => tickRetention(fastify), ms("6h")).unref?.();
        return;
    }

    setTimeout(() => {
        void tickFlush(fastify);
        void tickDaily(fastify);
    }, ms("5s")).unref?.();

    setInterval(() => tickFlush(fastify), ANALYTICS_FLUSH_INTERVAL_MS).unref?.();
    // Check for the daily job every 15 min
    setInterval(() => tickDaily(fastify), ms("15m")).unref?.();
}
