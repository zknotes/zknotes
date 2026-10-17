// `startServer` is the one place the process start lives. An installation with extensions calls
// it with its own list rather than copying the sequence — and a copy is exactly how the health
// route got lost once. These tests lock in both halves of that promise: the ops route is there,
// and so are the extensions the caller passed in.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import type { ApiExtension } from "../src/server";
import { startServer } from "../src/start";

const probe: ApiExtension = {
    name: "start-server-probe",
    register: async (fastify) => {
        fastify.get("/start-server-probe", async () => ({ ok: true }));
    },
};

const saved = { PORT: process.env.PORT, ANALYTICS_DISABLED: process.env.ANALYTICS_DISABLED };
let app: FastifyInstance;

beforeAll(async () => {
    // Any free port, so the test never collides with a dev server. setup.ts already sets
    // GC_DISABLED; the analytics scheduler is switched off here the same way.
    process.env.PORT = "0";
    process.env.ANALYTICS_DISABLED = "1";
    app = await startServer({ extensions: [probe] });
});

afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("startServer", () => {
    test("registers /health, which buildApp alone does not", async () => {
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
    });

    test("brings up the extensions it is given", async () => {
        const res = await app.inject({ method: "GET", url: "/start-server-probe" });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: true });
    });

    test("is listening on a real port", () => {
        const address = app.server.address();
        expect(typeof address === "object" && address !== null && address.port > 0).toBe(true);
    });
});
