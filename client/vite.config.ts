import { resolve } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import pkg from "../package.json";
import { changelogPlugin } from "../scripts/changelog/vite-changelog-plugin";

// A reproducible build takes its timestamp from the commit, not from the clock: SOURCE_DATE_EPOCH
// (seconds, UTC — the reproducible-builds.org convention) is set by the release build and by
// scripts/verify-reproducible.sh. Without it (dev, an ad-hoc self-host build) the clock is used, as
// before. A malformed value fails the build here instead of surfacing as an Invalid Date deep in
// the bundle.
function buildDate(): string {
    const raw = process.env.SOURCE_DATE_EPOCH;
    if (!raw) return new Date().toISOString();
    if (!/^\d+$/.test(raw)) {
        throw new Error(`SOURCE_DATE_EPOCH must be whole seconds since the epoch, got "${raw}"`);
    }
    return new Date(Number(raw) * 1000).toISOString();
}

export default defineConfig({
    resolve: {
        alias: {
            $lib: resolve(__dirname, "src/lib"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
        __BUILD_DATE__: JSON.stringify(buildDate()),
        __COMMIT_HASH__: JSON.stringify(process.env.APP_COMMIT ?? "dev"),
    },
    plugins: [
        // Dev-only: the shell title in app.html before Svelte hydrates (pageTitle() covers the routes).
        {
            name: "dev-local-title-prefix",
            transformIndexHtml(html, ctx) {
                if (!ctx.server) return html;
                return html.replaceAll("<title>ZKnotes</title>", "<title>LOCAL-ZKnotes</title>");
            },
        },
        tailwindcss(),
        sveltekit(),
        changelogPlugin({ limit: 20 }),
    ],
    build: {
        // Fonts always ship as files: an inlined `data:` font is blocked by the production CSP
        // (`font-src 'self'`). Other small assets keep Vite's default inlining.
        assetsInlineLimit: (filePath) =>
            /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
        rollupOptions: {
            output: {
                // Keep the ENTIRE `shared` package in one chunk. Without this Vite scatters it into
                // two (topoSortByParent/createsCycle end up in the engine chunk while ITEM_LIMITS stays in
                // the shared chunk), so shared imports back out of the engine → a circular chunk. Every
                // module-scope read of a shared value then lands in the TDZ and brings down the whole
                // application — invisible in `vite dev` because of live bindings.
                advancedChunks: {
                    groups: [{ name: "zknotes-shared", test: /[\\/]shared[\\/]src/ }],
                },
            },
        },
    },
    // The export modules (html/full-backup/plaintext) are loaded dynamically from Settings; without an
    // eager pre-bundle, Vite discovers fflate only on the click and the browser can get a 504 Outdated
    // Optimize Dep.
    //
    // The workers are start-up scan entries because SvelteKit scans only the route files, and a worker
    // loaded through `new URL(…)` is not followed from them. Without these, Vite found the crypto
    // worker's `minisearch` only when the first page booted the worker, re-bundled and reloaded every
    // open page — which landed in the middle of the first E2E tests' sign-in. Vite
    // concatenates this list with SvelteKit's route globs, so the routes stay scanned.
    optimizeDeps: {
        entries: ["src/lib/core/workers/*.worker.ts"],
        include: ["fflate"],
    },
    server: {
        host: true,
        proxy: {
            // NOTE: only the real API prefixes the server exposes are listed here
            // (auth/items/uploads/me/shares/client-error; the history routes live under
            // /items/:id/history).
            // `/files` is a SvelteKit route (routes/(app)/files), NOT an API endpoint — proxying it
            // would send a full refresh or a navigation to /files to the API host, where it breaks
            // (an ECONNREFUSED in dev and in the E2E). The API's file calls go to /uploads and /me.
            //
            // This list is the dev equivalent of the production path routing: a new API prefix
            // ⇒ update the @api matcher in docker/Caddyfile and API_PREFIXES in
            // src/service-worker.ts. /client-log and /dev-* are dev-only (Caddy does not have them).
            "/auth": "http://127.0.0.1:3000",
            // The core's vault registration. It was missing here, in Caddy and in
            // the service worker too, which is why a self-host's first registration returned 404 in
            // production — E2E does not catch that, because there the client hits the API directly
            // through VITE_API_URL.
            "/vault": "http://127.0.0.1:3000",
            "/items": "http://127.0.0.1:3000",
            "/restore": "http://127.0.0.1:3000",
            "/uploads": "http://127.0.0.1:3000",
            "/me": "http://127.0.0.1:3000",
            "/shares": "http://127.0.0.1:3000",
            "/instance-config": "http://127.0.0.1:3000",
            "/client-error": "http://127.0.0.1:3000",
            "/client-log": "http://127.0.0.1:3000",
            "/dev-logs-stream": "http://127.0.0.1:3000",
            "/dev-log-level": "http://127.0.0.1:3000",
            "/dev-logs": "http://127.0.0.1:3000",
        },
    },
    worker: {
        format: "es",
        rollupOptions: {
            output: {
                entryFileNames: "assets/[name].js", // No hash for shared worker
            },
        },
    },
});
