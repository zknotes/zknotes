/**
 * TRUST_PROXY / per-IP rate-limit behaviour behind a reverse proxy.
 * Builds a dedicated app instance so trustProxy is re-read from env.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createTestUser } from "./helpers";

const CLIENT_ERROR_MAX = 30; // app.ts default CLIENT_ERROR_RATELIMIT_MAX

describe("rate-limit buckets are per client IP behind a trusted proxy", () => {
    let app: FastifyInstance;
    let prevTrust: string | undefined;
    let prevRl: string | undefined;

    beforeAll(async () => {
        prevTrust = process.env.TRUST_PROXY;
        prevRl = process.env.RATE_LIMIT_IN_TEST;
        process.env.TRUST_PROXY = "127.0.0.1"; // the injected requests come from 127.0.0.1
        process.env.RATE_LIMIT_IN_TEST = "1";
        app = await buildApp();
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        if (prevTrust === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = prevTrust;
        if (prevRl === undefined) delete process.env.RATE_LIMIT_IN_TEST;
        else process.env.RATE_LIMIT_IN_TEST = prevRl;
    });

    test("rate-limit buckets are per client IP behind a trusted proxy", async () => {
        // Two different XFFs below the limit (CLIENT_ERROR_MAX=30) → neither may get a 429.
        // If trustProxy does not work, everyone shares the socket IP and 2×25 > 30 → 429.
        const perIp = 25;
        const statuses: number[] = [];
        for (const xff of ["203.0.113.10", "203.0.113.20"]) {
            for (let i = 0; i < perIp; i++) {
                const res = await app.inject({
                    method: "POST",
                    url: "/client-error",
                    headers: { "x-forwarded-for": xff },
                    remoteAddress: "127.0.0.1",
                    payload: { message: "rl-probe" },
                });
                statuses.push(res.statusCode);
            }
        }
        expect(statuses.every((s) => s === 200)).toBe(true);
        expect(statuses).not.toContain(429);
    });

    test("addresses in one IPv6 /64 share a bucket", async () => {
        // Rotating through a /64 must not buy a fresh quota: past CLIENT_ERROR_MAX → 429.
        const statuses: number[] = [];
        for (let i = 0; i < CLIENT_ERROR_MAX + 5; i++) {
            const res = await app.inject({
                method: "POST",
                url: "/client-error",
                headers: { "x-forwarded-for": `2001:db8:77:1::${(i + 1).toString(16)}` },
                remoteAddress: "127.0.0.1",
                payload: { message: "rl-probe-v6" },
            });
            statuses.push(res.statusCode);
            if (res.statusCode === 429) break;
        }
        expect(statuses[0]).toBe(200);
        expect(statuses).toContain(429);
    });
});

describe("X-Forwarded-For from an untrusted source is ignored", () => {
    let app: FastifyInstance;
    let prevTrust: string | undefined;
    let prevRl: string | undefined;

    beforeAll(async () => {
        prevTrust = process.env.TRUST_PROXY;
        prevRl = process.env.RATE_LIMIT_IN_TEST;
        // Trust only 10.0.0.0/8 — inject remoteAddress 192.0.2.1 is outside that range.
        process.env.TRUST_PROXY = "10.0.0.0/8";
        process.env.RATE_LIMIT_IN_TEST = "1";
        app = await buildApp();
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        if (prevTrust === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = prevTrust;
        if (prevRl === undefined) delete process.env.RATE_LIMIT_IN_TEST;
        else process.env.RATE_LIMIT_IN_TEST = prevRl;
    });

    test("X-Forwarded-For from an untrusted source is ignored", async () => {
        // The same socket IP with different forged XFFs → they share a bucket (the spoof is ignored) → 429 past the max.
        const statuses: number[] = [];
        for (let i = 0; i < CLIENT_ERROR_MAX + 5; i++) {
            const res = await app.inject({
                method: "POST",
                url: "/client-error",
                headers: { "x-forwarded-for": `198.51.100.${(i % 50) + 1}` },
                remoteAddress: "192.0.2.1",
                payload: { message: "spoof-probe" },
            });
            statuses.push(res.statusCode);
            if (res.statusCode === 429) break;
        }
        expect(statuses).toContain(429);
        // Proof that we did not get a 429 on the first request (the limiter works; this is not an error).
        expect(statuses[0]).toBe(200);
    });
});

function restoreEnv(key: string, prev: string | undefined): void {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
}

function assertRateLimitBody(res: { statusCode: number; json: () => unknown }): void {
    expect(res.statusCode).toBe(429);
    const body = res.json() as Record<string, unknown>;
    expect(body.statusCode).toBe(429);
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.message).toBe("Too many attempts. Try again later.");
    expect(JSON.stringify(body)).not.toContain("user_id");
}

describe("authenticated GET rate-limit is per user_id", () => {
    let app: FastifyInstance;
    const prev: Record<string, string | undefined> = {};

    beforeAll(async () => {
        for (const key of [
            "TRUST_PROXY",
            "RATE_LIMIT_IN_TEST",
            "AUTHENTICATED_READ_USER_RATELIMIT_MAX",
            "AUTHENTICATED_READ_IP_RATELIMIT_MAX",
        ]) {
            prev[key] = process.env[key];
        }
        process.env.TRUST_PROXY = "127.0.0.1"; // the injected requests come from 127.0.0.1
        process.env.RATE_LIMIT_IN_TEST = "1";
        // The per-user read ceiling is lowered so the tests do not need 121 requests. The IP limit
        // stays high so the NAT test does not hit the outer layer before the inner one.
        process.env.AUTHENTICATED_READ_USER_RATELIMIT_MAX = "5";
        process.env.AUTHENTICATED_READ_IP_RATELIMIT_MAX = "600";
        // AUTH_REGISTER_RATELIMIT_MAX is read when auth.ts is imported (not at buildApp), so it has
        // no effect here. We keep to ≤5 createTestUser calls in this describe while
        // RATE_LIMIT_IN_TEST=1.
        app = await buildApp();
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        for (const [key, value] of Object.entries(prev)) restoreEnv(key, value);
    });

    async function getItems(cookie: string, xff?: string) {
        return app.inject({
            method: "GET",
            url: "/items?limit=1000",
            headers: {
                cookie,
                ...(xff ? { "x-forwarded-for": xff } : {}),
            },
            remoteAddress: "127.0.0.1",
        });
    }

    test("per-user read, NAT, the 429 shape, the inverted-condition guard, per-route separation", async () => {
        const uniq = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const a = await createTestUser(app, { email: `rl-ac1-a-${uniq}@example.com` });
        const b = await createTestUser(app, { email: `rl-ac1-b-${uniq}@example.com` });
        const c = await createTestUser(app, { email: `rl-ac8-c-${uniq}@example.com` });
        const xff = "203.0.113.40";

        const aStatuses: number[] = [];
        let limited: { statusCode: number; json: () => unknown } | undefined;
        for (let i = 0; i < 6; i++) {
            const res = await getItems(a.cookie, xff);
            aStatuses.push(res.statusCode);
            if (res.statusCode === 429) limited = res;
        }
        // The first 4 have to be 200 (this fails if the condition is `isAllowed === false`).
        expect(aStatuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
        // A's 6th request is a 429; B behind the same IP is still 200.
        expect(aStatuses[4]).toBe(200);
        expect(aStatuses[5]).toBe(429);
        expect(limited).toBeDefined();
        assertRateLimitBody(limited!);

        const bRes = await getItems(b.cookie, xff);
        expect(bRes.statusCode).toBe(200);

        // An exhausted GET /items does not touch GET /auth/me.
        const me = await app.inject({
            method: "GET",
            url: "/auth/me",
            headers: { cookie: a.cookie },
        });
        expect(me.statusCode).toBe(200);

        // In reverse: an exhausted GET /auth/me does not touch GET /items.
        for (let i = 0; i < 6; i++) {
            const res = await app.inject({
                method: "GET",
                url: "/auth/me",
                headers: { cookie: c.cookie },
            });
            if (i < 5) expect(res.statusCode).toBe(200);
            else expect(res.statusCode).toBe(429);
        }
        const itemsRes = await getItems(c.cookie);
        expect(itemsRes.statusCode).toBe(200);
    });

    test("rotating the IP does not get around the per-user limit", async () => {
        const { cookie } = await createTestUser(app, {
            email: `rl-ac2-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`,
        });
        const statuses: number[] = [];
        const xffs = ["203.0.113.50", "203.0.113.51"];
        for (let i = 0; i < 6; i++) {
            const res = await getItems(cookie, xffs[i % 2]);
            statuses.push(res.statusCode);
        }
        expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
        expect(statuses[5]).toBe(429);
    });
});

describe("unauthenticated flood on POST /items still hits IP layer", () => {
    let app: FastifyInstance;
    const prev: Record<string, string | undefined> = {};

    beforeAll(async () => {
        for (const key of ["RATE_LIMIT_IN_TEST", "AUTHENTICATED_MUTATION_RATELIMIT_MAX"]) {
            prev[key] = process.env[key];
        }
        process.env.RATE_LIMIT_IN_TEST = "1";
        process.env.AUTHENTICATED_MUTATION_RATELIMIT_MAX = "5";
        app = await buildApp();
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        for (const [key, value] of Object.entries(prev)) restoreEnv(key, value);
    });

    test("an invalid session_token hits the IP 429 before an unbounded DB lookup", async () => {
        const statuses: number[] = [];
        let limited: { statusCode: number; json: () => unknown } | undefined;
        for (let i = 0; i < 8; i++) {
            const res = await app.inject({
                method: "POST",
                url: "/items",
                headers: { cookie: "session_token=definitely-not-a-real-session" },
                payload: { id: "not-validated-when-unauth" },
            });
            statuses.push(res.statusCode);
            if (res.statusCode === 429) {
                limited = res;
                break;
            }
        }
        expect(statuses[0]).toBe(401);
        expect(statuses).toContain(429);
        expect(statuses.indexOf(429)).toBeGreaterThan(0);
        assertRateLimitBody(limited!);
    });
});

describe("deploy posture", () => {
    test("docker-compose trusts X-Forwarded-For only from the edge network it shares with Caddy", () => {
        // A service's networks are a list, or a map when one needs options (Caddy's storage alias).
        type Service = {
            networks?: string[] | Record<string, unknown>;
            environment?: Record<string, string>;
        };
        const names = (s?: Service) =>
            Array.isArray(s?.networks) ? s.networks : Object.keys(s?.networks ?? {});
        const compose = Bun.YAML.parse(
            readFileSync(resolve(import.meta.dir, "../../docker/docker-compose.yml"), "utf8"),
        ) as {
            services: Record<string, Service>;
            networks: { edge: { ipam: { config: { subnet: string }[] } } };
        };
        const { api, caddy, db } = compose.services;
        // Without TRUST_PROXY every client would share Caddy's address: one global bucket.
        expect(api?.environment?.TRUST_PROXY).toBe(
            "${TRUST_PROXY:-${EDGE_SUBNET:-172.30.250.0/24}}",
        );
        expect(compose.networks.edge.ipam.config[0]?.subnet).toBe(
            "${EDGE_SUBNET:-172.30.250.0/24}",
        );
        // `edge` must be the only network Caddy and the API share, or Caddy could reach the API
        // from an address outside the trusted subnet.
        const shared = names(api).filter((n) => names(caddy).includes(n));
        expect(shared).toEqual(["edge"]);
        expect(db?.networks).toEqual(["backend"]);
    });

    // Rootless Docker does not pass a UDP client's address through: HTTP/3 visitors would all share
    // one address in the per-address limits.
    test("HTTP/3 is off: no UDP port published, and Caddy speaks h1 and h2 only", () => {
        const compose = Bun.YAML.parse(
            readFileSync(resolve(import.meta.dir, "../../docker/docker-compose.yml"), "utf8"),
        ) as { services: Record<string, { ports?: string[] }> };
        expect(compose.services.caddy?.ports?.some((p) => p.includes("/udp"))).toBe(false);
        const caddyfile = readFileSync(resolve(import.meta.dir, "../../docker/Caddyfile"), "utf8");
        expect(caddyfile).toMatch(/servers\s*\{\s*protocols h1 h2\s*\}/);
    });

    test("authenticated mutation routes have a rate limit configured", () => {
        const items = readFileSync(resolve(import.meta.dir, "../src/routes/items.ts"), "utf8");
        const history = readFileSync(resolve(import.meta.dir, "../src/routes/history.ts"), "utf8");
        const files = readFileSync(resolve(import.meta.dir, "../src/routes/files.ts"), "utf8");
        // The mutations have to use authMut / ipRateLimit.
        expect(items).toMatch(/fastify\.post\("\/items", authMut/);
        expect(items).toMatch(/fastify\.put\("\/items\/:id", authMut/);
        expect(items).toMatch(/fastify\.delete\("\/items\/:id", authMut/);
        expect(history).toMatch(/fastify\.post\("\/items\/:id\/history", authMut/);
        expect(history).toMatch(/fastify\.delete\("\/items\/:id\/history", authMut/);
        expect(files).toMatch(
            /\/me\/storage"[\s\S]{0,80}authStorageRl|authStorageRl[\s\S]{0,40}\/me\/storage/,
        );
    });
});
