import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    lastFailed,
    parseResultsCache,
    resultsCachePath,
    selectFailed,
} from "./vitest-last-failed";

/**
 * `./test.sh --last-failed` trusts this helper to decide which vitest files run, so both directions
 * matter: a file that failed must come back, and a file that passed, belongs to another project or
 * lies outside the layer must not. Anything the helper cannot read has to come back as "no cache"
 * (null) — that is what makes test.sh run the whole layer instead of silently running nothing.
 */

/** The shape vitest 4.1.10 writes, trimmed to a few entries. */
const CACHE = JSON.stringify({
    version: "4.1.10",
    results: [
        ["unit:src/lib/a.test.ts", { duration: 12.5, failed: true }],
        ["unit:src/lib/b.test.ts", { duration: 3, failed: false }],
        ["dom:src/lib/c.dom.test.ts", { duration: 40, failed: true }],
        ["integration:src/lib/d.integration.test.ts", { duration: 90, failed: false }],
    ],
});

describe("resultsCachePath", () => {
    it("matches the directory vitest writes for an unnamed config", () => {
        // sha1("") — the directory name on disk in client/, shared/ and the repository root.
        expect(resultsCachePath("/repo/client")).toBe(
            "/repo/client/node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json",
        );
    });
});

describe("parseResultsCache", () => {
    it("reads the project, the file and the failed flag of every entry", () => {
        expect(parseResultsCache(CACHE)).toEqual([
            { project: "unit", file: "src/lib/a.test.ts", failed: true },
            { project: "unit", file: "src/lib/b.test.ts", failed: false },
            { project: "dom", file: "src/lib/c.dom.test.ts", failed: true },
            { project: "integration", file: "src/lib/d.integration.test.ts", failed: false },
        ]);
    });

    it("reads a config without projects as the empty project name", () => {
        const text = JSON.stringify({
            version: "4.1.10",
            results: [[":src/x.test.ts", { duration: 1, failed: true }]],
        });
        expect(parseResultsCache(text)).toEqual([
            { project: "", file: "src/x.test.ts", failed: true },
        ]);
    });

    it.each([
        ["not JSON", "{"],
        ["no results array", JSON.stringify({ version: "4.1.10" })],
        ["an entry that is not a pair", JSON.stringify({ results: [["unit:a.test.ts"]] })],
        ["a key without a project", JSON.stringify({ results: [["a.test.ts", { failed: true }]] })],
        ["no failed flag", JSON.stringify({ results: [["unit:a.test.ts", { duration: 1 }]] })],
        ["null", "null"],
    ])("returns null for %s, so the layer runs whole", (_label, text) => {
        expect(parseResultsCache(text)).toBeNull();
    });
});

describe("selectFailed", () => {
    const results = parseResultsCache(CACHE) ?? [];

    it("returns the failed files of the asked project only", () => {
        expect(selectFailed(results, "unit")).toEqual(["src/lib/a.test.ts"]);
        expect(selectFailed(results, "dom")).toEqual(["src/lib/c.dom.test.ts"]);
    });

    it("returns nothing for a project whose last run passed", () => {
        expect(selectFailed(results, "integration")).toEqual([]);
    });

    it("keeps only the files below `under`", () => {
        const mixed = [
            { project: "", file: "scripts/a.test.ts", failed: true },
            { project: "", file: "client/src/b.test.ts", failed: true },
        ];
        expect(selectFailed(mixed, "", "scripts/")).toEqual(["scripts/a.test.ts"]);
    });
});

describe("lastFailed", () => {
    let root = "";

    afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true });
        root = "";
    });

    function writeCache(text: string): void {
        const path = resultsCachePath(root);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
    }

    function touch(file: string): void {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), "");
    }

    it("returns null when vitest has never run here", () => {
        root = mkdtempSync(join(tmpdir(), "vitest-last-failed-"));
        expect(lastFailed(root, "unit")).toBeNull();
    });

    it("returns the failed files as absolute paths", () => {
        root = mkdtempSync(join(tmpdir(), "vitest-last-failed-"));
        touch("src/lib/a.test.ts");
        touch("src/lib/b.test.ts");
        writeCache(CACHE);
        expect(lastFailed(root, "unit")).toEqual([join(root, "src/lib/a.test.ts")]);
    });

    it("drops a failed file that no longer exists", () => {
        root = mkdtempSync(join(tmpdir(), "vitest-last-failed-"));
        writeCache(CACHE);
        expect(lastFailed(root, "unit")).toEqual([]);
    });

    it("returns null for a cache it cannot read", () => {
        root = mkdtempSync(join(tmpdir(), "vitest-last-failed-"));
        writeCache("{ not json");
        expect(lastFailed(root, "unit")).toBeNull();
    });
});
