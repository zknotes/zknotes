import { existsSync } from "node:fs";
import { FILE_LIMITS } from "@zknotes/shared";

/**
 * One place of truth for the Chrome resolution and the API test-server env, instead of the same
 * literal duplicated across the Playwright configs.
 */

/** The Vite dev server the chromium project runs against (the warm-up in `e2e/global-setup.ts` too). */
export const E2E_WEB_PORT = 5188;
/** The SOURCE_URL the E2E API serves through /instance-config — the legal footer links to it. */
export const E2E_SOURCE_URL = "https://example.com/zknotes-source";

/**
 * The system Chrome — cross-platform. CI/Linux has `/bin/google-chrome`, macOS has Chrome.app.
 * Override through `CHROME_PATH`. If nothing is found → `undefined`, and Playwright falls back to the
 * bundled Chromium (which needs `bunx playwright install chromium`).
 */
export function resolveChromePath(): string | undefined {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const candidates =
        process.platform === "darwin"
            ? [
                  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                  "/Applications/Chromium.app/Contents/MacOS/Chromium",
              ]
            : [
                  "/bin/google-chrome",
                  "/usr/bin/google-chrome",
                  "/usr/bin/chromium",
                  "/usr/bin/chromium-browser",
              ];
    return candidates.find((p) => existsSync(p));
}

/**
 * The `webServer` entry for the API test server — the same env as the existing e2e (Argon2 turned
 * down, the GC switched off).
 *
 * `extraEnv` exists so each config can add **only** what its own scope needs (the account layer's
 * origins, say) without a second copy of the whole env block.
 */
export function apiWebServer(
    apiPort: number,
    corsOrigins: string[],
    extraEnv: Record<string, string> = {},
) {
    return {
        command: "exec bun index.ts",
        url: `http://localhost:${apiPort}/health`,
        timeout: 30_000,
        cwd: "../server",
        reuseExistingServer: !process.env.CI,
        env: {
            NODE_ENV: "test",
            PORT: String(apiPort),
            DATABASE_URL: "postgresql://zknotes:zknotes@localhost:5433/zknotes_test",
            FILE_STORAGE_PATH: "./storage-e2e",
            CORS_ORIGIN: corsOrigins.join(","),
            COOKIE_SECRET: "test-cookie-secret-must-be-32bytes!!",
            KDF_FAKE_SEED: "test-fake-kdf-seed-32-bytes-long!",
            ARGON2_MEMORY_COST: "1024",
            ARGON2_TIME_COST: "1",
            ARGON2_PARALLELISM: "1",
            MIN_AUTH_RESPONSE_MS: "0",
            // The core closes registration after the FIRST user (`server/src/routes/vault.ts`).
            // Without this, every `create-vault` but the first gets a 403 `registration_closed` while
            // the UI still redirects to /login — so the test only fails there, with "Invalid
            // credentials". The same thing `server/test/setup.ts` does for the bun tests.
            SELF_HOST_REGISTRATION_OPEN: "true",
            // The core's permissive provider hands out 100 GB (`server/src/entitlements.ts`) because a
            // self-host has no plan. The E2E needs a SMALL quota: `03-files` asserts "0 B / 1.0 GB
            // used" and then that the figure moves after a 2 KB upload — against 100 GB it would still
            // read 0 B, so the 1 GB is pinned here.
            SELF_HOST_STORAGE_QUOTA: String(1024 * 1024 * 1024),
            // The same for the per-file ceiling: the permissive provider hands a self-host 2 GB, so
            // `12-files-upload` — which writes a sparse file of MAX_FILE_SIZE + 1 B and expects the
            // editor to refuse it before any POST /uploads — was uploading a perfectly legal file and
            // waiting for an error that never came. Pinned to the shared constant the test asserts
            // against, so the server limit and the expected message cannot drift apart again.
            SELF_HOST_MAX_FILE_SIZE: String(FILE_LIMITS.MAX_FILE_SIZE),
            // The GC scheduler is a no-op in e2e (see playwright.config.ts) — the same reason applies here.
            GC_DISABLED: "1",
            LOG_LEVEL: "warn",
            S3_ENDPOINT: "http://localhost:9002",
            S3_REGION: "us-east-1",
            S3_BUCKET: "zknotes-e2e",
            S3_ACCESS_KEY: "minioadmin",
            S3_SECRET_KEY: "minioadmin-dev-secret",
            // So the legal footer has a Source link to assert on (01-auth.spec.ts).
            SOURCE_URL: E2E_SOURCE_URL,
            ...extraEnv,
        },
    };
}
