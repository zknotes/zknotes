// API responses carried no Cache-Control, so a browser could keep GET /auth/me (the wrapped Vault
// Key, the KDF salt and parameters) or a pull page in its disk cache after the user signed out.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createTestUser, resetDb } from "./helpers";

let app: FastifyInstance;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(resetDb);

describe("Cache-Control on API responses", () => {
    test("account data and pulls are no-store", async () => {
        const { cookie } = await createTestUser(app);
        for (const url of ["/auth/me", "/items?limit=10", "/auth/sessions"]) {
            const res = await app.inject({ method: "GET", url, headers: { cookie } });
            expect(res.statusCode).toBe(200);
            expect(res.headers["cache-control"]).toBe("no-store");
        }
    });

    test("errors and public routes are no-store too", async () => {
        const unauthorized = await app.inject({ method: "GET", url: "/auth/me" });
        expect(unauthorized.statusCode).toBe(401);
        expect(unauthorized.headers["cache-control"]).toBe("no-store");

        const config = await app.inject({ method: "GET", url: "/instance-config" });
        expect(config.headers["cache-control"]).toBe("no-store");
    });
});
