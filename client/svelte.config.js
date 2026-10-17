import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
const config = {
    compilerOptions: {
        // Force runes mode for the project, libraries aside. It can be removed in Svelte 6.
        runes: ({ filename }) =>
            filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
    },
    kit: {
        // SPA mode (zero-knowledge, client-only — the whole app is ssr=false): a static build with an
        // `index.html` fallback for every route. Kept in step with docker/nginx
        // (try_files … /index.html) and required for the PWA offline app shell.
        adapter: adapter({ fallback: "index.html" }),
        // In dev we do not register the SW: `build` and `files` are empty sets (Vite does not
        // generates the production chunks), so PRECACHE_PATHS contains nothing. The SW then catches
        // every same-origin GET and answers 503 when Vite does not serve an unexpected URL — blocking
        // the lazy JS modules and preventing a sync. A production build works normally.
        serviceWorker: {
            register: false,
        },
        // The prerendered fallback (index.html) gets a <meta http-equiv=content-security-policy>
        // carrying the sha256 hash of SvelteKit's bootstrap inline script ("hash" mode works for the
        // prerender too — kit/src/runtime/server/page/csp.js). The header CSP (docker/nginx) has to
        // carry the SAME hash, because a header and a meta apply as an intersection. 'wasm-unsafe-eval'
        // is mandatory: hash-wasm (Argon2id) does not work without it. 'worker-src blob:' has to be
        // explicit (the same as in nginx): without it the browser falls back to script-src, while the
        // Vite HMR ping and the Chromium SharedWorker both create blob: workers — and an upload then
        // times out.
        // In DEV, SvelteKit sends the CSP as a header (there is no prerender), so this applies locally too.
        csp: {
            mode: "hash",
            directives: {
                "script-src": ["self", "wasm-unsafe-eval"],
                "worker-src": ["self", "blob:"],
                // The same as docker/nginx.conf.template: no images from other sites (a note must not
                // tell a third party when it is opened). Without it, dev showed images that production
                // blocks.
                "img-src": ["self", "data:", "blob:"],
            },
        },
    },
    vitePlugin: {
        inspector: !process.env.PROD,
    },
    // It keeps the Vite terminal free of a11y/css warnings on every HMR.
    // (vite-plugin-svelte 7 requires onwarn at the config's root, not under vitePlugin.)
    onwarn(warning, handler) {
        if (
            warning.code === "css_unused_selector" ||
            warning.code === "a11y_no_static_element_interactions"
        ) {
            return;
        }
        handler(warning);
    },
};

export default config;
