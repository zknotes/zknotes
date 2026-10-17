/**
 * A standalone migration script — it runs the Drizzle migrations programmatically.
 * It uses drizzle-orm (a production dependency), not drizzle-kit (a dev dependency).
 * docker/entrypoint.sh calls it when the container starts.
 *
 * Usage: bun run /app/server/migrate.ts
 */
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set");

const client = postgres(url, { onnotice: () => {} });
const db = drizzle({ client });

// Session-level lock so two API replicas cannot race drizzle migrate() on a shared database.
const MIGRATE_LOCK_KEY = 872_015_001;

await client`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`;
try {
    console.log("[migrate] Running core migrations…");
    await migrate(db, { migrationsFolder: resolve(import.meta.dir, "./drizzle") });
    console.log("[migrate] Done.");
} finally {
    await client`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`;
    await client.end();
}
