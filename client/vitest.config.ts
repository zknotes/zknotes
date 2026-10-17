import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
    // The Svelte plugin compiles the `.svelte.ts` rune modules (core/stores/*, for instance) so they can
    // be unit-tested; without it `$state` is undefined in a node environment.
    plugins: [svelte()],
    // The build-time constants vite.config.ts defines, with fixed test values: a component that shows
    // the version (LegalFooter, on the sign-in page) otherwise throws a ReferenceError under test.
    define: {
        __APP_VERSION__: JSON.stringify("0.0.0-test"),
        __BUILD_DATE__: JSON.stringify("2026-01-01T00:00:00.000Z"),
        __COMMIT_HASH__: JSON.stringify("test"),
    },
    resolve: {
        alias: {
            $lib: resolve(__dirname, "src/lib"),
            // The SvelteKit virtual modules — vitest has no kit alias; these are stubs for the unit/dom tests.
            "$app/navigation": resolve(__dirname, "src/test-stubs/app-navigation.ts"),
            "$app/environment": resolve(__dirname, "src/test-stubs/app-environment.ts"),
            "$app/state": resolve(__dirname, "src/test-stubs/app-state.ts"),
        },
    },
    test: {
        // Three layers: unit (pure logic), dom (jsdom + the TipTap/ProseMirror view) and integration
        // (fake-indexeddb + an IDB/API mock).
        // test.sh runs unit/integration through a targeted --project; the default run does all three.
        // unit excludes *.dom.test.ts (which goes to the dom project).
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    include: ["src/**/*.test.ts"],
                    exclude: ["src/**/*.integration.test.ts", "src/**/*.dom.test.ts"],
                    environment: "node",
                },
            },
            {
                extends: true,
                // `import { mount } from "svelte"` would otherwise resolve index-server.js (the
                // package.json default), and mount() would throw lifecycle_function_unavailable.
                resolve: {
                    conditions: ["browser"],
                },
                test: {
                    name: "dom",
                    include: ["src/**/*.dom.test.ts"],
                    environment: "jsdom",
                },
            },
            {
                extends: true,
                test: {
                    name: "integration",
                    include: ["src/**/*.integration.test.ts"],
                    environment: "node",
                },
            },
        ],
    },
});
