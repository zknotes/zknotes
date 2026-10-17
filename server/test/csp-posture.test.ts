/**
 * Deploy posture: enforcing CSP with script hashes (no unsafe-inline scripts)
 * and a slot for storage origin. Runtime header smoke remains manual
 * (`curl -I https://app…`); this guards the config that builds the header.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

// `server/test` → `server` → the repo root.
const repoRoot = resolve(import.meta.dir, "../..");

describe("production CSP posture", () => {
    test("CSP is enforced on web/nginx with script-hash slot, not a hash-less Caddy policy", () => {
        const caddy = readFileSync(join(repoRoot, "docker/Caddyfile"), "utf8");
        const nginxTemplate = readFileSync(join(repoRoot, "docker/nginx.conf.template"), "utf8");
        const dockerfileWeb = readFileSync(join(repoRoot, "docker/Dockerfile.web"), "utf8");
        const compose = readFileSync(join(repoRoot, "docker/docker-compose.yml"), "utf8");

        // Caddy must NOT send a second CSP that AND-intersects with nginx and
        // drops script hashes (that was the production white-screen bug).
        expect(caddy).not.toMatch(/header Content-Security-Policy/);
        expect(caddy).not.toMatch(/Content-Security-Policy-Report-Only/);

        // nginx template is the enforcing policy SoT for the SPA document.
        expect(nginxTemplate).toMatch(/Content-Security-Policy/);
        // hash-wasm Argon2id needs Wasm compile; 'wasm-unsafe-eval' ≠ full 'unsafe-eval'.
        expect(nginxTemplate).toMatch(
            /script-src 'self' 'wasm-unsafe-eval' \{\{CSP_SCRIPT_HASHES\}\}/,
        );
        expect(nginxTemplate).toMatch(/\$\{CSP_CONNECT_EXTRA\}/);
        expect(nginxTemplate).toMatch(/img-src 'self' data: blob:/);
        // Blob workers: Vite HMR ping (dev SharedWorker from blob:), Chromium SharedWorker
        // fallback. If worker-src is omitted, browsers fall back to script-src which has
        // no blob: — upload/HMR then die with ADD_ITEM_KEY timeouts.
        expect(nginxTemplate).toMatch(/worker-src 'self' blob:/);
        expect(nginxTemplate).toMatch(/default-src 'none'/);
        expect(nginxTemplate).toMatch(/object-src 'none'/);
        expect(nginxTemplate).toMatch(/base-uri 'none'/);
        expect(nginxTemplate).toMatch(/frame-ancestors 'none'/);
        expect(nginxTemplate).toMatch(/form-action 'self'/);
        expect(nginxTemplate).toMatch(/style-src 'self' 'unsafe-inline'/);

        for (const line of nginxTemplate.split("\n")) {
            if (!/Content-Security-Policy/.test(line)) continue;
            // Never reopen script-src unsafe-inline for the app shell (style-src may use it).
            expect(line).not.toMatch(/script-src[^;]*'unsafe-inline'/);
            // Bare 'unsafe-eval' is forbidden; 'wasm-unsafe-eval' is required and OK.
            expect(line).not.toMatch(/(?<!wasm-)'unsafe-eval'/);
            expect(line).toMatch(/'wasm-unsafe-eval'/);
            expect(line).toMatch(/worker-src 'self' blob:/);
            expect(line).toMatch(/default-src 'none'/);
            expect(line).toMatch(/object-src 'none'/);
            expect(line).toMatch(/base-uri 'none'/);
            expect(line).toMatch(/frame-ancestors 'none'/);
            expect(line).toMatch(/form-action 'self'/);
            expect(line).toMatch(/style-src /);
        }

        // kit.csp is AND-intersected with the nginx header (prerender meta + header).
        // Missing worker-src here silently undoes nginx's blob: allowance.
        const svelteConfig = readFileSync(join(repoRoot, "client/svelte.config.js"), "utf8");
        expect(svelteConfig).toMatch(/"worker-src"\s*:\s*\[\s*"self"\s*,\s*"blob:"\s*\]/);

        // Build wires hash extraction + template bake.
        expect(dockerfileWeb).toMatch(/extract-csp-script-hashes\.ts/);
        expect(dockerfileWeb).toMatch(/\{\{CSP_SCRIPT_HASHES\}\}/);
        expect(dockerfileWeb).toMatch(/nginx-default\.conf\.template/);

        // Storage origin for presigned PUT/GET.
        expect(compose).toMatch(/CSP_CONNECT_EXTRA:\s*\$\{S3_ENDPOINT/);
    });

    test("extract-csp-script-hashes emits CSP-compatible sha256 tokens for inline scripts", async () => {
        const dir = mkdtempSync(join(tmpdir(), "csp-hash-"));
        const bodyA = "\nconsole.log('a');\n";
        const bodyB = "\n{ __sveltekit = true }\n";
        const html = `<!doctype html><script>${bodyA}</script><script src="/x.js"></script><script>${bodyB}</script>`;
        const htmlPath = join(dir, "index.html");
        writeFileSync(htmlPath, html);

        const out =
            await $`bun ${join(repoRoot, "docker/extract-csp-script-hashes.ts")} ${htmlPath}`.text();
        const tokens = out.trim().split(/\s+/).filter(Boolean);
        expect(tokens).toHaveLength(2);

        const expected = [bodyA, bodyB].map((body) => {
            const digest = createHash("sha256").update(body, "utf8").digest("base64");
            return `'sha256-${digest}'`;
        });
        expect(tokens).toEqual(expected);
    });
});
