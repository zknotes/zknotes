// The deep repair's schedule: due by `gc_runs`, not by a process timer, claimed by one
// instance at a time, retried after the lease when it fails.
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { db } from "../src/db";
import { gcRuns } from "../src/db/schema";
import {
    claimDeepRepair,
    DEEP_REPAIR_JOB,
    DEEP_REPAIR_LEASE_SECONDS,
    type DeepRepairResult,
    type GcResult,
    runDeepRepairIfDue,
} from "../src/gc";
import { createGcTick, startGcScheduler } from "../src/gc-scheduler";
import { resetDb } from "./helpers";

const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;
const NOW = 1_800_000_000;

const repaired: DeepRepairResult = {
    orphanDirs: 0,
    ghostRows: 0,
    committedOrphans: 0,
    usersReconciled: 0,
};
const swept: GcResult = {
    authSessions: 0,
    signInFailures: 0,
    extensions: {},
    uploadSessions: 0,
    blobsPurged: 0,
    bytesReclaimed: 0,
    autoPurgedItems: 0,
    orphanChunkSetsMarked: 0,
    itemTombstones: 0,
    deletedLogRows: 0,
    shareLinksExpired: 0,
    shareLinksDeleted: 0,
    restoreSessions: 0,
};
const silentLog = {
    info() {},
    error() {},
    warn() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
        return silentLog;
    },
    level: "silent",
} as unknown as FastifyBaseLogger;

async function deepRow() {
    const rows = await db.select().from(gcRuns).where(eq(gcRuns.job, DEEP_REPAIR_JOB));
    return rows[0];
}

async function succeededAt(at: number) {
    await db
        .insert(gcRuns)
        .values({ job: DEEP_REPAIR_JOB, last_started_at: at, last_success_at: at });
}

/** A repair that counts its runs instead of listing the bucket. */
function countingRepair() {
    const counter = { runs: 0 };
    const repair = async () => {
        counter.runs++;
        return repaired;
    };
    return { counter, repair };
}

describe("the deep repair's schedule", () => {
    beforeEach(resetDb);

    test("never run → it runs on the first tick, and the success is written down", async () => {
        const { counter, repair } = countingRepair();

        const result = await runDeepRepairIfDue({ now: NOW, intervalSeconds: WEEK, repair });

        expect(result).toEqual(repaired);
        expect(counter.runs).toBe(1);
        expect(await deepRow()).toMatchObject({ last_started_at: NOW, last_success_at: NOW });
    });

    test("a success a day ago is not due; one eight days ago is", async () => {
        const { counter, repair } = countingRepair();
        await succeededAt(NOW - DAY);
        expect(await runDeepRepairIfDue({ now: NOW, intervalSeconds: WEEK, repair })).toBeNull();

        await resetDb();
        await succeededAt(NOW - 8 * DAY);
        expect(await runDeepRepairIfDue({ now: NOW, intervalSeconds: WEEK, repair })).toEqual(
            repaired,
        );
        expect(counter.runs).toBe(1);
    });

    test("instances asking at once — exactly one claims it, first run or a due one", async () => {
        const ask = () => claimDeepRepair({ now: NOW, intervalSeconds: WEEK });

        const first = await Promise.all([ask(), ask(), ask()]);
        expect(first.filter(Boolean)).toHaveLength(1);

        await resetDb();
        await succeededAt(NOW - 8 * DAY);
        const due = await Promise.all([ask(), ask(), ask(), ask(), ask()]);
        expect(due.filter(Boolean)).toHaveLength(1);
    });

    test("a failure keeps the last success, and the next try waits out the lease", async () => {
        await succeededAt(NOW - 8 * DAY);
        await expect(
            runDeepRepairIfDue({
                now: NOW,
                intervalSeconds: WEEK,
                repair: async () => {
                    throw new Error("S3 unreachable");
                },
            }),
        ).rejects.toThrow("S3 unreachable");
        expect(await deepRow()).toMatchObject({
            last_started_at: NOW,
            last_success_at: NOW - 8 * DAY,
        });

        const { counter, repair } = countingRepair();
        // The next 15-minute tick: still inside the lease.
        expect(
            await runDeepRepairIfDue({ now: NOW + 15 * 60, intervalSeconds: WEEK, repair }),
        ).toBeNull();
        // Once the lease has run out.
        expect(
            await runDeepRepairIfDue({
                now: NOW + DEEP_REPAIR_LEASE_SECONDS,
                intervalSeconds: WEEK,
                repair,
            }),
        ).toEqual(repaired);
        expect(counter.runs).toBe(1);
    });
});

describe("the GC tick", () => {
    test("a tick that meets a busy sweep does not lose the deep repair — it runs after the sweep", async () => {
        let releaseSweep!: () => void;
        const sweepGate = new Promise<void>((resolve) => {
            releaseSweep = resolve;
        });
        const order: string[] = [];
        const tick = createGcTick({
            log: silentLog,
            deepIntervalSeconds: WEEK,
            runGc: async () => {
                order.push("sweep");
                await sweepGate;
                return swept;
            },
            runDeepRepairIfDue: async () => {
                order.push("deep");
                return repaired;
            },
        });

        const busy = tick();
        await tick(); // fires while the sweep runs: skipped, as a second tick always was
        releaseSweep();
        await busy;

        expect(order).toEqual(["sweep", "deep"]);
    });

    test("a sweep that fails does not skip the deep repair", async () => {
        const order: string[] = [];
        const tick = createGcTick({
            log: silentLog,
            deepIntervalSeconds: WEEK,
            runGc: async () => {
                order.push("sweep");
                throw new Error("db hiccup");
            },
            runDeepRepairIfDue: async () => {
                order.push("deep");
                return null;
            },
        });

        await tick();

        expect(order).toEqual(["sweep", "deep"]);
    });

    test("GC_DISABLED=1 schedules nothing; otherwise one start-up tick and one interval", () => {
        const timeouts = spyOn(globalThis, "setTimeout").mockImplementation((() => ({
            unref() {},
        })) as unknown as typeof setTimeout);
        const intervals = spyOn(globalThis, "setInterval").mockImplementation((() => ({
            unref() {},
        })) as unknown as typeof setInterval);
        const fastify = { log: silentLog } as unknown as FastifyInstance;
        try {
            // test/setup.ts sets GC_DISABLED=1 for the whole suite.
            startGcScheduler(fastify);
            expect(timeouts).not.toHaveBeenCalled();
            expect(intervals).not.toHaveBeenCalled();

            delete process.env.GC_DISABLED;
            startGcScheduler(fastify);
            expect(timeouts).toHaveBeenCalledTimes(1);
            // The deep repair's own week-long interval is gone: every ordinary tick asks gc_runs.
            expect(intervals).toHaveBeenCalledTimes(1);
        } finally {
            process.env.GC_DISABLED = "1";
            timeouts.mockRestore();
            intervals.mockRestore();
        }
    });
});
