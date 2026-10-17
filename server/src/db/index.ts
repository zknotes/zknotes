import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set");

const pgPoolMax = process.env.PG_POOL_MAX ? Number(process.env.PG_POOL_MAX) : 20;
const statementTimeout = process.env.PG_STATEMENT_TIMEOUT_MS
    ? Number(process.env.PG_STATEMENT_TIMEOUT_MS)
    : 15000;
const idleInTxTimeout = process.env.PG_IDLE_IN_TRANSACTION_TIMEOUT_MS
    ? Number(process.env.PG_IDLE_IN_TRANSACTION_TIMEOUT_MS)
    : 30000;

// onnotice: NOTICEs are logged in dev only (not in tests — the preload silences them for TRUNCATE)
export const pgClient = postgres(databaseUrl, {
    max: pgPoolMax,
    connection: {
        statement_timeout: statementTimeout,
        idle_in_transaction_session_timeout: idleInTxTimeout,
    },
    onnotice: process.env.NODE_ENV === "production" ? undefined : () => {},
    // postgres.js returns int8 as a string. Drizzle converts its own `bigint` columns, but raw SQL
    // (history-service.ts, COUNT(*), SUM over byte columns) would hand strings to code that expects
    // numbers. Every int8 here — epoch seconds, byte counts, row counts — stays far below 2^53, so it
    // is parsed as a number once, in this one place.
    types: {
        int8: {
            to: 20,
            from: [20],
            serialize: (value: number) => String(value),
            parse: (raw: string) => Number(raw),
        },
    },
    // Recycle connections: this prevents a stale pool after a Docker restart or a network break.
    idle_timeout: 60, // close connections idle for more than 60s
    max_lifetime: 600, // always recycle a connection after 10 min
    connect_timeout: 10, // fail fast when the database is unreachable
});
export const db = drizzle({ client: pgClient, schema });

// Graceful shutdown — without this the Bun process hangs on a Docker restart.
const shutdown = async () => {
    await pgClient.end({ timeout: 5 });
    process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
