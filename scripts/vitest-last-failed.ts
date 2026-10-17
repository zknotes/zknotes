/**
 * Lists the test files that failed on vitest's last recorded run — `./test.sh --last-failed` for
 * the vitest layers.
 *
 * Why it exists: Vitest 4 has no `--last-failed`. Verified against the installed 4.1.10:
 * `vitest --help` lists no such option, and the only "rerun failed" path is the `f` key in watch
 * mode, which works from in-memory state and needs a terminal. test.sh used to pass the flag
 * anyway, and every vitest step died at once with `CACError: Unknown option --lastFailed`.
 *
 * What vitest does keep is its results cache: after every run it records, per test file, whether
 * that file failed (it schedules failed and slow files first from it). This script reads that
 * cache and prints the failed files as absolute paths, which vitest takes as exact file filters.
 *
 * Two limits, stated rather than hidden:
 *   1. The granularity is the file, not the test — the cache records no test names, so a file
 *      with one failing test re-runs whole. Playwright's --last-failed is per test.
 *   2. The cache format is vitest's own, not a public API. Anything this script does not
 *      recognise reads as "no cache", and the caller then runs the whole layer — never fewer
 *      tests than it should.
 *
 * Exit status:
 *   0  the cache was read; stdout lists the failed files, one per line — possibly none
 *   2  there is no usable cache (the layer never ran here, or an unknown format)
 *
 * Usage:
 *   bun run scripts/vitest-last-failed.ts <root> [project] [under]
 *     root     the directory vitest runs from — its `root`, where node_modules/.vite lives
 *     project  the vitest project name (`unit`, `dom`, …); "" or omitted for a config without them
 *     under    report only files below this path, relative to root (`scripts/`, for instance)
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** One test file's entry in vitest's results cache. */
export interface CachedResult {
    /** The vitest project name; "" for a config without projects. */
    project: string;
    /** Relative to the vitest root. */
    file: string;
    failed: boolean;
}

/**
 * Where vitest keeps the results cache of a config rooted at `root`:
 * `<root>/node_modules/.vite/vitest/<sha1 of the config's name>/results.json` (VitestCache
 * .resolveCacheDir). None of the configs test.sh runs has a name, hence sha1(""). A config that
 * moves `cacheDir` moves the file with it; this path then does not exist, which reads as no cache.
 */
export function resultsCachePath(root: string, configName = ""): string {
    const hash = createHash("sha1").update(configName).digest("hex");
    return join(root, "node_modules", ".vite", "vitest", hash, "results.json");
}

/**
 * Parses results.json — `{ version, results: [["<project>:<file>", { duration, failed }], …] }`.
 * Returns null for anything that is not that shape, so a format change fails safe.
 */
export function parseResultsCache(text: string): CachedResult[] | null {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    const results = (data as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) return null;
    const parsed: CachedResult[] = [];
    for (const entry of results) {
        if (!Array.isArray(entry) || entry.length !== 2) return null;
        const [key, value] = entry as [unknown, unknown];
        const failed = (value as { failed?: unknown } | null)?.failed;
        if (typeof key !== "string" || typeof failed !== "boolean") return null;
        // Vitest writes the key as `${projectName}:${relativePath}`; a project name has no colon.
        const colon = key.indexOf(":");
        if (colon === -1) return null;
        parsed.push({ project: key.slice(0, colon), file: key.slice(colon + 1), failed });
    }
    return parsed;
}

/** The failed files of one project, optionally only those below `under`. */
export function selectFailed(results: CachedResult[], project: string, under = ""): string[] {
    return results
        .filter((r) => r.failed && r.project === project && r.file.startsWith(under))
        .map((r) => r.file);
}

/**
 * The absolute paths of the files that failed on the last recorded run and still exist, or null
 * when there is no usable cache. A deleted or renamed file is dropped: vitest rejects a filter
 * that matches nothing ("No test files found"), and a file that is gone cannot fail again.
 */
export function lastFailed(root: string, project: string, under = ""): string[] | null {
    const path = resultsCachePath(root);
    if (!existsSync(path)) return null;
    const results = parseResultsCache(readFileSync(path, "utf8"));
    if (results === null) return null;
    return selectFailed(results, project, under)
        .map((file) => resolve(root, file))
        .filter((file) => existsSync(file));
}

// Bun sets `import.meta.main`; under Node it is undefined, which is what keeps vitest from
// running the CLI on import.
if (import.meta.main) {
    const [root, project = "", under = ""] = process.argv.slice(2);
    if (!root) {
        console.error("Usage: bun run scripts/vitest-last-failed.ts <root> [project] [under]");
        process.exit(1);
    }
    const files = lastFailed(resolve(root), project, under);
    if (files === null) process.exit(2);
    for (const file of files) console.log(file);
}
