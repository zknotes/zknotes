/**
 * Emit space-separated CSP script-src hash tokens for every inline <script>
 * body in a built HTML shell (adapter-static index.html).
 *
 * Used at web image build time so nginx can send an enforcing CSP without
 * 'unsafe-inline', while still allowing SvelteKit's bootstrap inline script
 * (hashes change every build with hashed asset filenames).
 *
 * Usage: bun docker/extract-csp-script-hashes.ts path/to/index.html
 * Stdout: 'sha256-…' 'sha256-…'
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
    console.error("usage: extract-csp-script-hashes.ts <index.html>");
    process.exit(2);
}

const html = readFileSync(path, "utf8");
// Classic inline scripts only (no src=). Non-greedy body; case-insensitive tags.
const re = /<script\b(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
const hashes: string[] = [];
for (const match of html.matchAll(re)) {
    const body = match[1] ?? "";
    const digest = createHash("sha256").update(body, "utf8").digest("base64");
    hashes.push(`'sha256-${digest}'`);
}

// Empty is valid (all scripts external) — Caddy/nginx still use script-src 'self'.
process.stdout.write(hashes.join(" "));
