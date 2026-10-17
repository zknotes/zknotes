import { expect, test } from "@playwright/test";
import { registerUser, uniqueEmail, waitForVaultUnlocked } from "./helpers/auth";

// Unregisters the Service Workers and clears Cache Storage after each test so the browser context can
// shut down cleanly. Without this the SW stays active and the Playwright worker hangs for 300 s.
test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
    });
});

const PASSWORD = "correct-horse-battery-staple";

/**
 * Offline app-shell (PWA).
 *
 * It runs against the PRODUCTION preview build (the "pwa" project in playwright.config.ts):
 * Vite dev serves modules dynamically and does not precache them, so an offline cold start is not
 * reliable on the dev server. The other specs skip this file (the chromium testIgnore).
 *
 * A NOTE on the method: Playwright (CDP) does NOT route a top-level navigation through the service
 * worker while the network is offline — both `context.setOffline(true)` and `route.abort()` cut the
 * reload off BEFORE the SW (net::ERR_INTERNET_DISCONNECTED), so `page.reload()`
 * cannot demonstrate an offline cold start. So the offline app shell is verified through the
 * mechanisms that MAKE a cold start possible: (a) the SW precaches the app shell, (b) a precached
 * asset is served from Cache Storage even with the network dead, (c) the API and plaintext are NOT in
 * the cache (zero-knowledge).
 */
test.describe("PWA — offline app-shell", () => {
    test("service worker precaches app-shell and serves it without network (no API cached)", async ({
        page,
        context,
    }) => {
        // 1) The first online visit — the registration fills IDB; the SW installs and precaches the app shell.
        await registerUser(page, uniqueEmail(), PASSWORD);
        await waitForVaultUnlocked(page);

        // Wait for the SW to take control of the page (install plus precache finished).
        await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
            timeout: 30_000,
        });

        // An online reload through the SW — the app-shell HTML is definitely cached (plus the install fetch).
        await page.reload();
        await waitForVaultUnlocked(page);

        // 2) Audit Cache Storage: the app shell is present, NOT ONE API response (zero-knowledge).
        const audit = await page.evaluate(async () => {
            const names = await caches.keys();
            const shellCache = names.find((n) => n.startsWith("zknotes-shell-"));
            if (!shellCache) return null;
            const cache = await caches.open(shellCache);
            const urls = (await cache.keys()).map((r) => r.url);
            const assetUrl = urls.find((u) => u.includes("/_app/immutable/"));
            const shell = await cache.match("/__app_shell__");
            return {
                urls,
                assetUrl,
                shell: shell
                    ? { status: shell.status, contentType: shell.headers.get("content-type") }
                    : null,
            };
        });

        expect(audit).not.toBeNull();
        // The app-shell HTML is cached and ready for an offline navigation.
        expect(audit?.shell?.status).toBe(200);
        expect(audit?.shell?.contentType ?? "").toContain("text/html");
        // The precached build assets are present.
        expect(audit?.assetUrl).toBeTruthy();

        // Everything cached is same-origin (the API is cross-origin → never in the cache) and no
        // same-origin API path is cached.
        const pageOrigin = new URL(page.url()).origin;
        for (const u of audit?.urls ?? []) {
            const parsed = new URL(u);
            expect(parsed.origin).toBe(pageOrigin);
            expect(
                /\/(items|files|auth|me|history|uploads|shares|client-log|client-error)(\/|$)/.test(
                    parsed.pathname,
                ),
            ).toBe(false);
        }

        // 3) With the network dead: the SW serves the precached asset from the cache, while an
        //    uncached (network) resource fails — proof the 200 came from the cache, not the network.
        await context.route("**/*", (route) => route.abort("internetdisconnected"));
        const offline = await page.evaluate(async (assetUrl: string) => {
            const tryFetch = async (u: string) => {
                try {
                    const r = await fetch(u, { cache: "no-store" });
                    return r.ok;
                } catch {
                    return false;
                }
            };
            return {
                precachedAsset: await tryFetch(assetUrl),
                uncachedNetwork: await tryFetch(`/__not_cached__${Math.random()}`),
            };
        }, audit?.assetUrl ?? "");
        await context.unroute("**/*");

        expect(offline.precachedAsset).toBe(true); // served from the SW cache with no network
        expect(offline.uncachedNetwork).toBe(false); // the network really is dead
    });
});
