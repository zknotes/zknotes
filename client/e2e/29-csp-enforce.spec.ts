import { expect, test } from "@playwright/test";
import { registerUser, uniqueEmail, waitForVaultUnlocked } from "./helpers/auth";

/**
 * An enforced CSP (kit.csp mode:"hash" in svelte.config.js) must not block the app boot.
 *
 * It runs against the PRODUCTION preview build (the "pwa" project in playwright.config.ts), because
 * that is the only place SvelteKit injects the CSP as a <meta> into the prerendered index.html (in DEV
 * it sends the CSP as a header — worker-src blob: for the Vite HMR ping SharedWorker included).
 * The regression this catches: a new inline <script> in app.html/+layout, or a lost
 * 'wasm-unsafe-eval', would silently break the boot/Argon2id in production (confirmed in production
 * before this fix: the bootstrap script and WebAssembly.compile were both blocked).
 */
test.describe("CSP enforce — production build", () => {
    test("app boots, registers, and unlocks vault with zero CSP violations", async ({ page }) => {
        const violations: Record<string, unknown>[] = [];
        await page.exposeFunction("__reportCspViolation", (v: Record<string, unknown>) => {
            violations.push(v);
        });
        await page.addInitScript(() => {
            document.addEventListener("securitypolicyviolation", (e) => {
                // @ts-expect-error - injected by exposeFunction
                window.__reportCspViolation({
                    directive: e.violatedDirective,
                    blockedURI: e.blockedURI,
                    sourceFile: e.sourceFile,
                    lineNumber: e.lineNumber,
                    sample: (e.sample || "").slice(0, 120),
                    documentURI: e.documentURI,
                });
            });
        });

        // A registration forces the whole chain that an enforced CSP used to break before this fix:
        // SvelteKit bootstrap (inline script) + crypto SharedWorker + Argon2id (WebAssembly).
        await registerUser(page, uniqueEmail(), "correct-horse-battery-staple");
        await waitForVaultUnlocked(page);

        expect(violations, `CSP violations: ${JSON.stringify(violations)}`).toEqual([]);
    });
});
