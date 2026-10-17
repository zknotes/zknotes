/**
 * The credential routes answer no sooner than MIN_AUTH_RESPONSE_MS, whatever the outcome, so their
 * timing cannot tell an account that exists from one that does not. The floor used to wait after
 * `reply.send()` — the client already had its answer — and the suite runs with it at 0, so nothing
 * noticed. These tests raise it for themselves (it is read per request) and time real requests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../../src/app";
import { createTestUser, resetDb } from "../helpers";

const FLOOR_MS = 150;
const RIGHT = "A".repeat(44);
const WRONG = "B".repeat(44);

let app: FastifyInstance;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(resetDb);

async function timedWithFloor(request: InjectOptions) {
    const previous = {
        floor: process.env.MIN_AUTH_RESPONSE_MS,
        jitter: process.env.AUTH_JITTER_MS,
    };
    process.env.MIN_AUTH_RESPONSE_MS = String(FLOOR_MS);
    process.env.AUTH_JITTER_MS = "0";
    try {
        const started = performance.now();
        const res = await app.inject(request);
        return { res, ms: performance.now() - started };
    } finally {
        process.env.MIN_AUTH_RESPONSE_MS = previous.floor;
        process.env.AUTH_JITTER_MS = previous.jitter;
    }
}

describe("the response floor of the credential routes", () => {
    test("kdf-params for an address with no account", async () => {
        const { res, ms } = await timedWithFloor({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email: "nobody@example.com" },
        });
        expect(res.statusCode).toBe(200);
        expect(ms).toBeGreaterThanOrEqual(FLOOR_MS);
    });

    test("kdf-params for a real account", async () => {
        const { email } = await createTestUser(app);
        const { res, ms } = await timedWithFloor({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email },
        });
        expect(res.statusCode).toBe(200);
        expect(ms).toBeGreaterThanOrEqual(FLOOR_MS);
    });

    test("a login for an address with no account", async () => {
        const { res, ms } = await timedWithFloor({
            method: "POST",
            url: "/auth/login",
            payload: { email: "nobody@example.com", auth_key: WRONG },
        });
        expect(res.statusCode).toBe(401);
        expect(ms).toBeGreaterThanOrEqual(FLOOR_MS);
    });

    test("a login with the wrong password, and with the right one", async () => {
        const { email } = await createTestUser(app, { auth_key: RIGHT });
        for (const [authKey, status] of [
            [WRONG, 401],
            [RIGHT, 200],
        ] as const) {
            const { res, ms } = await timedWithFloor({
                method: "POST",
                url: "/auth/login",
                payload: { email, auth_key: authKey },
            });
            expect(res.statusCode).toBe(status);
            expect(ms).toBeGreaterThanOrEqual(FLOOR_MS);
        }
    });

    test("a validation error waits as well", async () => {
        const { res, ms } = await timedWithFloor({
            method: "POST",
            url: "/auth/kdf-params",
            payload: { email: "not-an-address" },
        });
        expect(res.statusCode).toBe(400);
        expect(ms).toBeGreaterThanOrEqual(FLOOR_MS);
    });

    test("registration", async () => {
        const { res, ms } = await timedWithFloor({
            method: "POST",
            url: "/vault",
            payload: {},
        });
        expect(res.statusCode).toBe(400);
        expect(ms).toBeGreaterThanOrEqual(FLOOR_MS);
    });

    test("routes outside the credential set are not slowed down", async () => {
        const { res, ms } = await timedWithFloor({
            method: "GET",
            url: "/auth/registration-status",
        });
        expect(res.statusCode).toBe(200);
        expect(ms).toBeLessThan(FLOOR_MS);
    });
});

describe("the body limit of the credential routes", () => {
    test("a body over 4 KiB is refused before it is parsed", async () => {
        for (const url of ["/auth/kdf-params", "/auth/login", "/vault"]) {
            const res = await app.inject({
                method: "POST",
                url,
                headers: { "content-type": "application/json" },
                payload: JSON.stringify({ email: `${"a".repeat(5000)}@example.com` }),
            });
            expect(res.statusCode).toBe(413);
        }
    });
});
