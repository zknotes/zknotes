// The daily analytics tick runs on a timer as `void tickDaily()`: nothing awaits it, so any
// rejection that escapes it is unhandled and ends the API process. A database that is not up yet
// must cost one logged error, not the server.
import { describe, expect, mock, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { tickDaily } from "../src/services/analytics/scheduler";

function fakeFastify() {
    const log = { info: mock(), error: mock() };
    return { fastify: { log } as unknown as Pick<FastifyInstance, "log">, log };
}

describe("analytics daily tick", () => {
    test("a database error while checking the day is logged, not thrown", async () => {
        const { fastify, log } = fakeFastify();
        const runDailyJob = mock(async () => {});

        await expect(
            tickDaily(fastify, {
                isPastSlot: () => true,
                isDayProcessed: async () => {
                    throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
                },
                runDailyJob,
            }),
        ).resolves.toBeUndefined();

        expect(log.error).toHaveBeenCalledTimes(1);
        expect(runDailyJob).not.toHaveBeenCalled();
    });

    test("the next tick tries again once the database is back", async () => {
        const { fastify, log } = fakeFastify();
        const runDailyJob = mock(async () => {});

        await tickDaily(fastify, {
            isPastSlot: () => true,
            isDayProcessed: async () => {
                throw new Error("database down");
            },
            runDailyJob,
        });
        await tickDaily(fastify, {
            isPastSlot: () => true,
            isDayProcessed: async () => false,
            runDailyJob,
        });

        expect(runDailyJob).toHaveBeenCalledTimes(1);
        expect(log.info).toHaveBeenCalledTimes(1);
    });
});
