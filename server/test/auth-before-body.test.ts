// Protected routes authenticated in preValidation, which Fastify runs after it has parsed the body:
// anyone without a session could make the API parse a body of up to the global 30 MB limit first,
// blocking the event loop for seconds per request. A malformed body shows the order — it is a 400
// if it is parsed first, a 401 if authentication comes first.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../src/app";

let app: FastifyInstance;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

const NOT_JSON = "{this is not json";

describe("authentication comes before the body is read", () => {
    for (const [method, url] of [
        ["POST", "/items"],
        ["POST", "/items/batch"],
        ["PUT", `/items/${uuidv7()}`],
        ["POST", "/restore/sessions"],
        ["POST", "/uploads"],
        ["POST", "/shares"],
        ["POST", "/auth/change-password"],
    ] as const) {
        test(`${method} ${url} without a session is a 401, not a parse error`, async () => {
            const res = await app.inject({
                method,
                url,
                headers: { "content-type": "application/json" },
                payload: NOT_JSON,
            });
            expect(res.statusCode).toBe(401);
        });
    }

    test("POST /shares/:id/view refuses a body larger than a few KiB", async () => {
        const res = await app.inject({
            method: "POST",
            url: `/shares/${uuidv7()}/view`,
            headers: { "content-type": "application/json" },
            payload: JSON.stringify({ view_proof: "x".repeat(64 * 1024) }),
        });
        expect(res.statusCode).toBe(413);
    });
});
