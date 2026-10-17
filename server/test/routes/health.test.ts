// `/health` is the one route that answers without any credentials, so it is the cheapest way to put
// load on an instance. These tests lock in the guard that makes it cheap for the server too: the
// database probe is cached, so a burst of requests does not become a burst of queries.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";
import rootPackage from "../../../package.json";
import {
    health,
    isDatabaseReachable,
    releaseVersion,
    resetHealthProbeCache,
} from "../../src/routes/health";

let app: FastifyInstance;

beforeAll(async () => {
    app = await buildApp({ extensions: [] });
    await app.register(health);
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(() => {
    resetHealthProbeCache();
});

describe("GET /health", () => {
    test("answers 200 with the ops fields and nothing else", async () => {
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.status).toBe("ok");
        expect(typeof body.uptime_seconds).toBe("number");
        expect(Object.keys(body).sort()).toEqual(["commit", "status", "uptime_seconds", "version"]);
    });

    test("reports the release version from the root package.json", async () => {
        expect(releaseVersion()).toBe(rootPackage.version);
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(JSON.parse(res.body).version).toBe(rootPackage.version);
    });

    test("a burst of requests still answers 200 for every one of them", async () => {
        for (let i = 0; i < 20; i++) {
            expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
        }
    });
});

describe("the health probe cache", () => {
    /**
     * The guard that matters, and the one a later refactor is most likely to undo: 20 calls inside
     * the window must reach the database once. Counting the real probes is what makes this a test
     * rather than a restatement of the code.
     */
    test("probes once per window, however many calls arrive", async () => {
        let calls = 0;
        const run = async () => {
            calls++;
        };
        const t0 = 1_000_000;
        for (let i = 0; i < 20; i++) await isDatabaseReachable(t0 + i, run);
        expect(calls).toBe(1);
    });

    test("probes again once the window has passed", async () => {
        let calls = 0;
        const run = async () => {
            calls++;
        };
        const t0 = 1_000_000;
        await isDatabaseReachable(t0, run);
        await isDatabaseReachable(t0 + 60_000, run);
        expect(calls).toBe(2);
    });

    /**
     * A failure is cached exactly like a success. That is deliberate: a database already struggling
     * should not also absorb a retry storm from an unauthenticated endpoint.
     */
    test("caches a failure too, and reports it as unreachable", async () => {
        let calls = 0;
        const failing = async () => {
            calls++;
            throw new Error("db down");
        };
        const t0 = 1_000_000;
        expect(await isDatabaseReachable(t0, failing)).toBe(false);
        expect(await isDatabaseReachable(t0 + 1, failing)).toBe(false);
        expect(calls).toBe(1);
    });

    test("recovers once the window passes", async () => {
        const t0 = 1_000_000;
        await isDatabaseReachable(t0, async () => {
            throw new Error("db down");
        });
        expect(await isDatabaseReachable(t0 + 60_000, async () => {})).toBe(true);
    });
});

/**
 * The second guard. Without it, the one endpoint that asks for no credentials is also the cheapest
 * way to load an instance. The ceiling is lowered through the environment so the test needs four
 * requests rather than sixty-one; the limiter itself is the production one.
 */
describe("the health rate limit", () => {
    let limited: FastifyInstance;
    let prevMax: string | undefined;
    let prevRl: string | undefined;

    beforeAll(async () => {
        prevMax = process.env.HEALTH_RATELIMIT_MAX;
        prevRl = process.env.RATE_LIMIT_IN_TEST;
        process.env.HEALTH_RATELIMIT_MAX = "3";
        process.env.RATE_LIMIT_IN_TEST = "1";
        limited = await buildApp({ extensions: [] });
        await limited.register(health);
        await limited.ready();
    });

    afterAll(async () => {
        await limited.close();
        if (prevMax === undefined) delete process.env.HEALTH_RATELIMIT_MAX;
        else process.env.HEALTH_RATELIMIT_MAX = prevMax;
        if (prevRl === undefined) delete process.env.RATE_LIMIT_IN_TEST;
        else process.env.RATE_LIMIT_IN_TEST = prevRl;
    });

    test("answers 429 once the per-IP ceiling is crossed", async () => {
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) {
            codes.push((await limited.inject({ method: "GET", url: "/health" })).statusCode);
        }
        expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
        expect(codes.slice(3)).toEqual([429, 429, 429]);
    });
});
