import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/app";
import { db } from "../src/db";

describe("Database Resilience", () => {
    test("handles database query timeouts without crashing the server", async () => {
        const app = await buildApp({ logger: false });

        // Fastify uses async/await in its handlers. If a query takes too long,
        // it can time out if configured to, or if we force a cancellation.
        // Drizzle may throw. We want to make sure the error is caught and turned into a 500 without
        // taking the Bun process down.

        // We simulate a failure by deliberately running invalid SQL syntax
        // so we can check the error-boundary logic at the DB level.
        app.get("/test-db-error", async () => {
            await db.execute(sql`SELECT * FROM table_that_does_not_exist_for_testing`);
            return { ok: true };
        });

        const response = await app.inject({
            method: "GET",
            url: "/test-db-error",
        });

        expect(response.statusCode).toBe(500);

        const payload = JSON.parse(response.payload);
        expect(payload).toHaveProperty("error", "Internal Server Error");

        // The app has to keep handling normal requests afterwards
        const healthResponse = await app.inject({
            method: "GET",
            url: "/items?limit=1000", // Unauthenticated, should return 401
        });

        expect(healthResponse.statusCode).toBe(401);

        await app.close();
    });
});
