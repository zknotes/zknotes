import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { warmVite } from "./helpers/warm-vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(__dirname, "../../server");

// The same test database docker-compose provisions (db_test → zknotes_test) and that the server's bun
// test uses. The E2E and API tests run sequentially (test.sh), so there is no conflict.
const E2E_DB_URL = "postgresql://zknotes:zknotes@localhost:5433/zknotes_test";

export default async function globalSetup(): Promise<void> {
    // Clear the previous test artefacts so every run starts from scratch
    await rm(resolve(apiDir, "storage-e2e"), { recursive: true, force: true });

    // Apply schema to the e2e test database via drizzle-kit, spawned from server —
    // drizzle-orm is not hoisted into the root node_modules, so a direct import from here does not work.
    const res = spawnSync("bunx", ["drizzle-kit", "migrate"], {
        cwd: apiDir,
        env: { ...process.env, DATABASE_URL: E2E_DB_URL },
        stdio: "inherit",
    });
    if (res.status !== 0) {
        throw new Error(`drizzle-kit migrate failed with exit code ${res.status}`);
    }

    // Create the test S3 bucket (on the test Garage instance) for the E2E tests
    const { S3Client, CreateBucketCommand, PutBucketCorsCommand } = await import(
        "@aws-sdk/client-s3"
    );
    const s3 = new S3Client({
        region: "us-east-1",
        endpoint: "http://localhost:9002",
        credentials: {
            accessKeyId: "minioadmin",
            secretAccessKey: "minioadmin-dev-secret",
        },
        forcePathStyle: true,
    });

    // garage_test (unlike the old MinIO image) ships no shell, so it has no container healthcheck —
    // `docker compose up --wait` can only wait for it to have started, not for the S3 API inside to
    // be accepting connections. Retrying for up to ~9 s closes that gap (a cold CI runner is the slow
    // case).
    try {
        for (let attempt = 1; ; attempt++) {
            try {
                await s3.send(new CreateBucketCommand({ Bucket: "zknotes-e2e" }));
                console.log("Created S3 bucket: zknotes-e2e");
                break;
            } catch (e: any) {
                if (e.name === "BucketAlreadyOwnedByYou" || e.name === "BucketAlreadyExists") break;
                if (attempt >= 30) throw e;
                await new Promise((r) => setTimeout(r, 300));
            }
        }

        // MinIO used to reflect any Origin by default, with no CORS configuration at all — Garage
        // does not, so the Playwright browser's presigned PUT/GET would otherwise fail CORS preflight.
        await s3.send(
            new PutBucketCorsCommand({
                Bucket: "zknotes-e2e",
                CORSConfiguration: {
                    CORSRules: [
                        {
                            AllowedOrigins: ["*"],
                            AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
                            AllowedHeaders: ["*"],
                        },
                    ],
                },
            }),
        );
    } catch (e) {
        console.error("Failed to create bucket:", e);
        throw e;
    } finally {
        s3.destroy();
    }

    // Last, so the dev server's start-up scan has had the migrations' time to finish.
    await warmVite();
}
