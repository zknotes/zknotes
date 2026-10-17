import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { E2E_WEB_PORT, resolveChromePath } from "../../playwright.shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Where Vite's dep optimizer records what it has pre-bundled for the client (and the workers).
const DEPS_METADATA = resolve(__dirname, "../../node_modules/.vite/deps/_metadata.json");

// The pages that boot the crypto SharedWorker — its imports are what the start-up scan used to miss —
// each with a field that renders only once the layout is past "Securing connection…".
const WARM_PAGES = [
    { path: "/login", ready: "Master password" },
    { path: "/create-vault", ready: "Email Address" },
];

// Long enough for a discovery the worker's boot triggered to reach the metadata file (about 1 s
// measured: request → re-bundle → write), short enough not to slow a warm run.
const QUIET_MS = 1_500;
const METADATA_TIMEOUT_MS = 60_000;
const PAGE_TIMEOUT_MS = 60_000;

async function readOptimizedDeps(): Promise<Set<string> | null> {
    try {
        const meta = JSON.parse(await readFile(DEPS_METADATA, "utf8")) as {
            optimized?: Record<string, unknown>;
        };
        return new Set(Object.keys(meta.optimized ?? {}));
    } catch {
        return null;
    }
}

async function waitForOptimizedDeps(): Promise<Set<string>> {
    const deadline = Date.now() + METADATA_TIMEOUT_MS;
    for (;;) {
        const deps = await readOptimizedDeps();
        if (deps) return deps;
        if (Date.now() > deadline) {
            throw new Error(
                `warm-vite: ${DEPS_METADATA} did not appear within ${METADATA_TIMEOUT_MS} ms`,
            );
        }
        await new Promise((r) => setTimeout(r, 200));
    }
}

/** Waits until the optimizer's record has not changed for QUIET_MS. */
async function waitForQuietOptimizer(): Promise<Set<string>> {
    let last = await waitForOptimizedDeps();
    let stableSince = Date.now();
    while (Date.now() - stableSince < QUIET_MS) {
        await new Promise((r) => setTimeout(r, 250));
        const now = (await readOptimizedDeps()) ?? last;
        if (now.size !== last.size || [...now].some((d) => !last.has(d))) {
            last = now;
            stableSince = Date.now();
        }
    }
    return last;
}

async function openReady(page: Page, path: string, placeholder: string): Promise<void> {
    await page.goto(`http://localhost:${E2E_WEB_PORT}${path}`);
    await page.getByPlaceholder(placeholder).waitFor({ timeout: PAGE_TIMEOUT_MS });
}

/**
 * Warms the Vite dev server before the first test.
 *
 * On a cold cache Vite pre-bundles only what its start-up scan finds. A dependency it discovers later
 * makes it re-bundle and reload every open page, which used to land in the middle of a test's sign-in
 * or registration. Here the pages that boot the crypto worker are opened once, and the run waits until
 * the optimizer has nothing left to do, so the tests start on a settled server.
 *
 * A dependency discovered only here is named in a warning: the fix is to let the start-up scan see it
 * (`optimizeDeps.entries` or `optimizeDeps.include` in `client/vite.config.ts`). The run continues —
 * the cache is warm by then.
 */
export async function warmVite(): Promise<void> {
    const before = await waitForOptimizedDeps();
    const browser = await chromium.launch({
        executablePath: resolveChromePath(),
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
        const page = await browser.newPage();
        for (const { path, ready } of WARM_PAGES) await openReady(page, path, ready);
        const after = await waitForQuietOptimizer();
        const late = [...after].filter((d) => !before.has(d)).sort();
        if (late.length > 0) {
            // One more pass on the re-bundled deps, so the first test does not meet a half-reloaded page.
            for (const { path, ready } of WARM_PAGES) await openReady(page, path, ready);
            console.warn(
                `\x1b[33mwarm-vite: Vite found ${late.join(", ")} only after start-up and reloaded the ` +
                    "page. Add it to optimizeDeps in client/vite.config.ts (entries for the file that " +
                    "imports it, or include) — this run is warm now and continues.\x1b[0m",
            );
        }
    } finally {
        await browser.close();
    }
}
