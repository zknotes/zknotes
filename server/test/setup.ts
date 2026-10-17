// A preload script — it has to run BEFORE any test import.
// It points DATABASE_URL at the test database and runs the migrations.

import { resolve } from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

process.env.DATABASE_URL = "postgresql://zknotes:zknotes@localhost:5433/zknotes_test";
process.env.KDF_FAKE_SEED = "test-fake-seed-exactly-thirtytwo!1";
process.env.MIN_AUTH_RESPONSE_MS = "0";
// Turn the jitter off in tests (the production default is > 0) — otherwise the auth suite slows down.
process.env.AUTH_JITTER_MS = "0";
process.env.ARGON2_MEMORY_COST = "1024";
process.env.ARGON2_TIME_COST = "1";
process.env.ARGON2_PARALLELISM = "1";
process.env.GC_DISABLED = "1";
// The account-wide sign-in lock defaults to 100 failures an hour; tests reach it with a few sources.
process.env.USER_LOGIN_ACCOUNT_MAX_ATTEMPTS = "12";

// The test object store — the garage_test container from docker-compose.yml (:9002, separate from dev's :9000).
// It has to be set before the tests import src/s3.ts (the client reads the environment when constructed).
process.env.S3_ENDPOINT = "http://localhost:9002";
process.env.S3_REGION = "us-east-1";
process.env.S3_BUCKET = "zknotes-test";
process.env.S3_ACCESS_KEY = "minioadmin";
process.env.S3_SECRET_KEY = "minioadmin-dev-secret";

// The core closes registration after the first user: without this, every `createTestUser`
// after the first gets a `403 registration_closed`. In an extended deployment the entitlements
// provider gates registration, so this switch is not needed there.
process.env.SELF_HOST_REGISTRATION_OPEN = "true";

// Run the migrations against the test database (idempotent — drizzle-kit migrate records what ran)
// onnotice: suppress PostgreSQL NOTICE messages (TRUNCATE CASCADE and the like) from the test output
const migrationClient = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const migrationDb = drizzle({ client: migrationClient });
await migrate(migrationDb, {
    migrationsFolder: resolve(import.meta.dir, "../drizzle"),
});
// The open-core tests migrate the core only.
await migrationClient.end();

// Create the test bucket (idempotent) — the presigned upload/download tests hit a real Garage
const s3 = new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
});
// garage_test (unlike the old MinIO image) ships no shell, so it has no container healthcheck —
// `docker compose up --wait` can only wait for it to have started, not for the S3 API inside to be
// accepting connections. Retrying for up to ~9 s closes that gap (a cold CI runner is the slow
// case).
for (let attempt = 1; ; attempt++) {
    try {
        await s3.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }));
        break;
    } catch (e: any) {
        if (e.name === "BucketAlreadyOwnedByYou" || e.name === "BucketAlreadyExists") break;
        if (attempt >= 30) throw e;
        await new Promise((r) => setTimeout(r, 300));
    }
}
s3.destroy();
