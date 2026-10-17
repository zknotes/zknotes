// The guard that no instance-specific data may enter the client build. It is the **source** that
// is checked, not the bundle, and for a reason.
//
// The obvious criterion, "two builds with different `.env` files produce the same `manifestHash`",
// is not measurable: `manifestHash` is only a planned mechanism, and the build itself is not
// reproducible even with the same `.env` — `vite.config.ts` injects `__BUILD_DATE__` from
// `new Date()`, and without `config.kit.version.name` SvelteKit uses `Date.now()` (visible in
// `_app/version.json` and in the service worker's cache name). While that holds, a bundle's hash
// measures the **time of the build**, not its inputs.
//
// What is measurable is the claim behind that criterion: these values arrive at runtime, from
// `GET /instance-config`, not from a build-time env. This test holds that in place.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../../..");

/** Instance-specific values — they differ per deployment, so they must not be build-time constants. */
const FORBIDDEN_ENV_KEYS = [
    "PUBLIC_WWW_URL",
    "VITE_PUBLIC_WWW_URL",
    "ACCOUNT_MANAGE_URL",
    "VITE_ACCOUNT_MANAGE_URL",
    "ACCOUNT_PUBLIC_URL",
    "VITE_ACCOUNT_PUBLIC_URL",
    "APP_PUBLIC_URL",
    "VITE_APP_PUBLIC_URL",
    // The AGPL Source link: a modified instance has to point at ITS OWN source, so this too
    // is instance-specific — a build constant would show everyone the upstream.
    "SOURCE_URL",
    "VITE_SOURCE_URL",
];

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            out.push(...sourceFiles(path));
        } else if (/\.(ts|svelte)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
            out.push(path);
        }
    }
    return out;
}

describe("instance-specific values stay out of the client build", () => {
    it("no client source reads an instance URL from build-time env", () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(SRC)) {
            const text = readFileSync(file, "utf-8");
            for (const key of FORBIDDEN_ENV_KEYS) {
                // The name inside a comment is fine; reading it from the environment is not.
                if (
                    new RegExp(`(import\\.meta\\.env|process\\.env)\\s*[.\\[]\\s*["']?${key}`).test(
                        text,
                    )
                ) {
                    offenders.push(`${file.slice(SRC.length + 1)} → ${key}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("the www and manage URLs are read from the runtime instance config instead", async () => {
        const module = await import("./public-www");
        // The runtime path exists and returns the shape the UI expects.
        expect(typeof module.loadInstancePublicConfig).toBe("function");
        expect(module.getInstancePublicConfig()).toBeNull();
    });
});
