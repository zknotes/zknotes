import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Bun version lives in one place: `packageManager` in the root package.json. CI reads it from
 * there (`bun-version-file`); the Dockerfiles cannot, so they repeat it, and this test is what keeps
 * the copies equal. Without it CI could test one runtime while the images ship another, and
 * `--frozen-lockfile` would fail on the lockfile's format instead of on a real dependency change.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface SourceFile {
    path: string;
    text: string;
}

/** Every place that names a Bun version and disagrees with `version`, as "path: line". */
function bunVersionDrift(version: string, files: SourceFile[]): string[] {
    const drift: string[] = [];
    for (const { path, text } of files) {
        for (const line of text.split("\n")) {
            for (const m of line.matchAll(/oven\/bun:([\w.-]+)/g)) {
                if (m[1] !== `${version}-alpine`) drift.push(`${path}: ${line.trim()}`);
            }
            // A workflow must read the version from package.json rather than carry its own.
            if (/^\s*bun-version:/.test(line)) drift.push(`${path}: ${line.trim()}`);
        }
    }
    return drift;
}

function pinnedBunVersion(): string {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const m = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "");
    if (!m?.[1])
        throw new Error(
            `package.json packageManager must be "bun@x.y.z", got ${pkg.packageManager}`,
        );
    return m[1];
}

function filesNamingBun(): SourceFile[] {
    const paths = [
        ...readdirSync(join(ROOT, "docker"))
            .filter((f) => f.startsWith("Dockerfile"))
            .map((f) => join("docker", f)),
        ...readdirSync(join(ROOT, ".github/workflows"))
            .filter((f) => f.endsWith(".yml"))
            .map((f) => join(".github/workflows", f)),
    ];
    return paths.map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
}

/**
 * Every workspace manifest whose `@types/bun` is not exactly `version`, as "path: specifier". A
 * dist-tag such as "latest" re-resolves on each install, so the day a new release is published
 * `--frozen-lockfile` fails for CI, the Docker images and anyone building from source.
 */
function typesBunDrift(version: string, manifests: SourceFile[]): string[] {
    const drift: string[] = [];
    for (const { path, text } of manifests) {
        const pkg = JSON.parse(text);
        for (const deps of [pkg.dependencies, pkg.devDependencies]) {
            const spec = deps?.["@types/bun"];
            if (spec !== undefined && spec !== version) drift.push(`${path}: ${spec}`);
        }
    }
    return drift;
}

function workspaceManifests(): SourceFile[] {
    const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const paths = ["package.json", ...root.workspaces.map((w: string) => join(w, "package.json"))];
    return paths.map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
}

describe("Bun version", () => {
    it("is pinned to an exact version in package.json", () => {
        expect(pinnedBunVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("is the same in every Dockerfile and workflow", () => {
        const files = filesNamingBun();
        expect(files.some((f) => f.path.startsWith("docker/"))).toBe(true);
        expect(bunVersionDrift(pinnedBunVersion(), files)).toEqual([]);
    });

    it("reports a Dockerfile or workflow that drifts", () => {
        const drifted: SourceFile[] = [
            { path: "docker/Dockerfile.x", text: "FROM oven/bun:1.3-alpine AS builder" },
            {
                path: ".github/workflows/x.yml",
                text: '        with:\n          bun-version: "1.3"',
            },
            { path: "docker/Dockerfile.ok", text: "FROM oven/bun:9.9.9-alpine" },
        ];
        expect(bunVersionDrift("9.9.9", drifted)).toEqual([
            "docker/Dockerfile.x: FROM oven/bun:1.3-alpine AS builder",
            '.github/workflows/x.yml: bun-version: "1.3"',
        ]);
    });

    it("is the exact @types/bun version in every workspace", () => {
        const manifests = workspaceManifests();
        expect(manifests.some((m) => JSON.parse(m.text).devDependencies?.["@types/bun"])).toBe(
            true,
        );
        expect(typesBunDrift(pinnedBunVersion(), manifests)).toEqual([]);
    });

    it("reports a workspace whose @types/bun is a tag or a range", () => {
        const drifted: SourceFile[] = [
            { path: "a/package.json", text: '{ "devDependencies": { "@types/bun": "latest" } }' },
            { path: "b/package.json", text: '{ "dependencies": { "@types/bun": "^9.9.9" } }' },
            { path: "c/package.json", text: '{ "devDependencies": { "@types/bun": "9.9.9" } }' },
            { path: "d/package.json", text: '{ "devDependencies": { "typescript": "^6" } }' },
        ];
        expect(typesBunDrift("9.9.9", drifted)).toEqual([
            "a/package.json: latest",
            "b/package.json: ^9.9.9",
        ]);
    });
});
