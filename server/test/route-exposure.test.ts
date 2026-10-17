/**
 * Every route the server exposes has to be routed everywhere the client reaches it.
 *
 * It exists because `POST /vault` — vault registration, the core's own route — was in **none**
 * of the three lists: the Caddy `@api` matcher (production), the Vite proxy (dev), and `API_PREFIXES` in the service
 * worker (the PWA). The consequence would be a 404 on a self-hoster's first registration in production, because
 * nginx would serve `/vault` as an SPA route. E2E does not catch that: there the client hits the
 * API **directly**
 * through `VITE_API_URL`, bypassing both the proxy and Caddy — the suite covers the flow, not the routing.
 *
 * The comment in `vite.config.ts` already stated the rule. A rule without a gate is a note.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "../src/app";

const ROOT = resolve(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** Dev-only routes: deliberately absent from the production routing (see the comment in docker/Caddyfile). */
const DEV_ONLY = /^\/(dev-|client-log)/;

/** Registered outside `buildApp` (in `startServer`), so printRoutes does not see it. */
const EXTRA_ROUTES = ["/health"];

/**
 * An ops route: the Docker healthcheck and an external monitor call it, never the client. It therefore **must** be in
 * Caddy (it arrives from outside) and in the SW list (so it is not cached if anyone does call it),
 * but it has no business in the Vite proxy — in dev nobody hits it through the client origin.
 */
const OPS_ONLY = new Set(["/health"]);

async function serverPrefixes(): Promise<string[]> {
    const app = await buildApp();
    try {
        await app.ready();
        const tops = new Set<string>(EXTRA_ROUTES);
        for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
            const m = line.match(/^[├└]── (\/\S*)/);
            const first = m?.[1]?.split("/").filter(Boolean)[0];
            if (first) tops.add(`/${first}`);
        }
        return [...tops].sort();
    } finally {
        await app.close();
    }
}

/** `@api path /auth /auth/* /vault …` — we take only the prefixes, without the `/*` variants. */
function caddyPrefixes(): string[] {
    const line = read("docker/Caddyfile").match(/^\s*@api path (.+)$/m)?.[1] ?? "";
    return [...new Set(line.split(/\s+/).filter((p) => p.startsWith("/") && !p.includes("*")))];
}

function viteProxyPrefixes(): string[] {
    const block = read("client/vite.config.ts").match(/proxy:\s*\{([\s\S]*?)\n\s{8}\}/)?.[1] ?? "";
    return [...block.matchAll(/"(\/[a-z0-9-]+)":/g)].map((m) => m[1] as string);
}

function serviceWorkerPrefixes(): string[] {
    const block =
        read("client/src/service-worker.ts").match(/API_PREFIXES = \[([\s\S]*?)\]/)?.[1] ?? "";
    return [...block.matchAll(/"(\/[a-z0-9-]+)"/g)].map((m) => m[1] as string);
}

describe("route exposure — the server's routes must be routed everywhere the client reaches them", () => {
    test("every product route prefix is in all three routing lists", async () => {
        const server = await serverPrefixes();
        const product = server.filter((p) => !DEV_ONLY.test(p));
        expect(product.length).toBeGreaterThan(5); // sanity: the parser did not silently return nothing

        const lists: Array<[string, string[], string[]]> = [
            ["docker/Caddyfile @api", caddyPrefixes(), product],
            [
                "client/vite.config.ts proxy",
                viteProxyPrefixes(),
                product.filter((p) => !OPS_ONLY.has(p)),
            ],
            ["client/src/service-worker.ts API_PREFIXES", serviceWorkerPrefixes(), product],
        ];

        for (const [where, list, required] of lists) {
            expect(list.length).toBeGreaterThan(5); // the parser has to find something, or the test passes silently
            const missing = required.filter((p) => !list.includes(p));
            expect({ where, missing }).toEqual({ where, missing: [] });
        }
    });

    test("no routing list names a prefix the server does not serve", async () => {
        const server = await serverPrefixes();
        for (const [where, list] of Object.entries({
            "docker/Caddyfile @api": caddyPrefixes(),
            "client/src/service-worker.ts API_PREFIXES": serviceWorkerPrefixes(),
        })) {
            // `/dev-log` in the SW list is a prefix that matches nothing: the matcher wants an exact
            // path or `prefix/`, and `/dev-log-level` is neither. Recorded, not a reason to fail.
            const stale = list.filter((p) => !server.includes(p) && !DEV_ONLY.test(p));
            expect({ where, stale }).toEqual({ where, stale: [] });
        }
    });
});
