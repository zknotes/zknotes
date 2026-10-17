import { describe, expect, it } from "bun:test";
import { pgClient } from "../src/db";

describe("db connection pool", () => {
    it("pg pool has an explicit max and statement timeout", () => {
        expect(pgClient.options.max).toBe(
            process.env.PG_POOL_MAX ? Number(process.env.PG_POOL_MAX) : 20,
        );
        expect((pgClient.options as any).connection?.statement_timeout).toBe(
            process.env.PG_STATEMENT_TIMEOUT_MS
                ? Number(process.env.PG_STATEMENT_TIMEOUT_MS)
                : 15000,
        );
        expect((pgClient.options as any).connection?.idle_in_transaction_session_timeout).toBe(
            process.env.PG_IDLE_IN_TRANSACTION_TIMEOUT_MS
                ? Number(process.env.PG_IDLE_IN_TRANSACTION_TIMEOUT_MS)
                : 30000,
        );
    });
});
