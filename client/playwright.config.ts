import { defineConfig, devices } from "@playwright/test";
import { apiWebServer, E2E_WEB_PORT, resolveChromePath } from "./playwright.shared";

const API_PORT = 3001;
const WEB_PORT = E2E_WEB_PORT;
// The PWA spec (17-offline-pwa) needs a production build: Vite dev does not precache modules, so an
// offline cold start is not dependable. It runs on a separate preview server.
const PREVIEW_PORT = 4188;

const CHROME_PATH = resolveChromePath();

export default defineConfig({
    testDir: "./e2e",
    timeout: 90_000,
    expect: { timeout: 15_000 },
    // E2E parallelism — Argon2id needs up to 4 threads per sign-in, see `workers` below.
    // workers = the ceiling for the whole run (4 locally, 2 on CI; override with E2E_WORKERS).
    // fullyParallel: true = tests inside one file run in parallel too. Override per file with
    // test.describe.configure({ mode: "default" }) (in order, with no fail-fast skip). mode: "serial"
    // only when tests share state (33-backup-restore-lifecycle). Auth is a beforeEach: a fresh
    // registerUser() per test, two client-side Argon2id derivations. storageState is not used (the
    // vault_key lives in sessionStorage). The client-side DEFAULT_KDF_PARAMS under vite dev are the
    // production ones; the ARGON2_* from playwright.shared.ts only lowers the server-side
    // auth_key_hash.
    fullyParallel: true,
    workers: process.env.CI ? 2 : Number(process.env.E2E_WORKERS ?? 4),
    retries: 0,
    // Fail fast: if the backend dies or hangs mid-run (the DB pool, Garage), we do not want
    // every remaining test to hang until its full timeout. Locally the run stops after 6 failures;
    // on CI it stays 0 (no limit) so the report stays complete.
    maxFailures: process.env.CI ? 0 : 6,
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: `http://localhost:${WEB_PORT}`,
        // `on-first-retry` together with `retries: 0` means a trace is NEVER recorded — which is why
        // one investigation spent three rounds guessing the cause from screenshots.
        // `retain-on-failure` records every test and keeps only the failures.
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        // Without these, an action or a navigation against a dead server hangs until the test timeout (90s).
        // 15s is far above a healthy time (the slowest test is ~10s), so it does not touch a healthy
        // run, while a hung operation fails fast.
        actionTimeout: 15_000,
        navigationTimeout: 15_000,
        // The PWA tests need an active service worker (precache, the offline app shell).
        serviceWorkers: "allow",
    },
    projects: [
        {
            name: "chromium",
            // The PWA and CSP-enforce specs go into a separate project against the preview build (see "pwa" below).
            testIgnore: /17-offline-pwa|29-csp-enforce/,
            use: {
                ...devices["Desktop Chrome"],
                launchOptions: {
                    // undefined → Playwright's bundled Chromium (needs `playwright install`)
                    executablePath: CHROME_PATH,
                    args: ["--no-sandbox", "--disable-setuid-sandbox"],
                },
            },
        },
        {
            name: "pwa",
            // The CSP is only really enforced on a production build (see 29-csp-enforce.spec.ts).
            testMatch: /17-offline-pwa|29-csp-enforce/,
            use: {
                ...devices["Desktop Chrome"],
                // A production build on the preview server — a real, precacheable app shell.
                baseURL: `http://localhost:${PREVIEW_PORT}`,
                launchOptions: {
                    executablePath: CHROME_PATH,
                    args: ["--no-sandbox", "--disable-setuid-sandbox"],
                },
            },
        },
    ],
    globalSetup: "./e2e/global-setup.ts",
    webServer: [
        // The GC, Argon2 and KDF environment is explained in playwright.shared.ts.
        apiWebServer(API_PORT, [
            `http://localhost:${WEB_PORT}`,
            `http://localhost:${PREVIEW_PORT}`,
        ]),
        {
            command: `bun run dev -- --port ${WEB_PORT} --strictPort`,
            url: `http://localhost:${WEB_PORT}`,
            timeout: 60_000,
            reuseExistingServer: !process.env.CI,
            env: {
                VITE_API_URL: `http://localhost:${API_PORT}`,
            },
        },
        // The preview server (a production build) is needed ONLY by the pwa project (17-offline-pwa).
        // `test:e2e` runs the chromium and pwa projects in TWO separate `playwright test` calls
        // (see package.json) — the chromium invocation sets `PW_NO_PREVIEW=1`, so we skip
        // the expensive build it does not need anyway. Why they are split: when both projects run in
        // one invocation, Playwright STOPS the idle chromium workers after the chromium tests to free a
        // slot for the pwa worker — that graceful stop hangs for up to 300s because the workers'
        // browsers do not close cleanly (an open SW or keep-alive), which produced a ~5-minute stall
        // plus "worker did not exit" errors. Each project on its own exits cleanly. (A bare
        // `playwright test` still works — without PW_NO_PREVIEW the preview comes up and the pwa
        // project passes, with the known hang.)
        ...(process.env.PW_NO_PREVIEW
            ? []
            : [
                  {
                      // VITE_API_URL is inlined into the build, so the preview talks to the same test
                      // API. `exec` is MANDATORY: without it, `&&` keeps /bin/sh as the parent of
                      // `bun run
                      // `bun run preview`, so Playwright's SIGTERM only kills sh — vite preview is
                      // left orphaned on the port and Playwright waits ~5 minutes before the SIGKILL.
                      // `exec` replaces sh with the preview server's process, so the SIGTERM arrives
                      // directly and the shutdown is immediate.
                      command: `bun run build && exec bun run preview -- --port ${PREVIEW_PORT} --strictPort`,
                      url: `http://localhost:${PREVIEW_PORT}`,
                      timeout: 180_000,
                      reuseExistingServer: !process.env.CI,
                      env: {
                          VITE_API_URL: `http://localhost:${API_PORT}`,
                      },
                  },
              ]),
    ],
});
