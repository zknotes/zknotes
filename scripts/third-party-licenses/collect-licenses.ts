// The third-party notice file. Every package whose code or assets ship in a build is listed with
// its license text, so the served bundle and the Docker images carry the attribution MIT-style
// licenses require in copies. It is generated at build time from the installed packages (the
// lockfile fixes them), never written by hand, and it is deterministic: the same node_modules give
// the same bytes, which matters because the web root's tree hash includes this file.
//
// Resolution follows Node's algorithm from each dependent's own directory (dir/node_modules/<name>,
// then the parent's, and so on), with realpath to merge the symlinks Bun's isolated layout uses.
// Workspace packages (private, `workspace:` specifiers) are walked but not listed — they are the
// product itself, not a third party.
import * as fs from "node:fs";
import * as path from "node:path";

export interface PackageNotice {
    name: string;
    version: string;
    /** The SPDX expression from package.json, or "UNKNOWN" when it declares none. */
    license: string;
    /** homepage, or the repository URL, when the manifest has one. */
    url: string | null;
    /** The `author` field, flattened — the only attribution when no license file ships. */
    author: string | null;
    /** The text of the LICENSE / COPYING files in the package root, or null when there is none. */
    licenseText: string | null;
}

interface Manifest {
    name?: string;
    version?: string;
    private?: boolean;
    license?: string | { type?: string };
    licenses?: Array<string | { type?: string }>;
    homepage?: string;
    repository?: string | { url?: string };
    author?: string | { name?: string; email?: string; url?: string };
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.|$)/i;

function readManifest(dir: string): Manifest | null {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Manifest;
    } catch {
        return null;
    }
}

/** Node's resolution: `<from>/node_modules/<name>`, then each parent's, up to the root. */
function findPackageDir(from: string, name: string): string | null {
    let dir = from;
    for (;;) {
        const candidate = path.join(dir, "node_modules", name);
        if (fs.existsSync(path.join(candidate, "package.json"))) {
            return fs.realpathSync(candidate);
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function licenseOf(m: Manifest): string {
    if (typeof m.license === "string" && m.license) return m.license;
    if (m.license && typeof m.license === "object" && m.license.type) return m.license.type;
    if (Array.isArray(m.licenses) && m.licenses.length > 0) {
        return m.licenses
            .map((l) => (typeof l === "string" ? l : (l.type ?? "")))
            .filter(Boolean)
            .join(" OR ");
    }
    return "UNKNOWN";
}

function urlOf(m: Manifest): string | null {
    if (m.homepage) return m.homepage;
    const repo = typeof m.repository === "string" ? m.repository : m.repository?.url;
    if (!repo) return null;
    return repo.replace(/^git\+/, "").replace(/\.git$/, "");
}

function authorOf(m: Manifest): string | null {
    if (!m.author) return null;
    if (typeof m.author === "string") return m.author;
    const parts = [m.author.name, m.author.email && `<${m.author.email}>`, m.author.url];
    const s = parts.filter(Boolean).join(" ");
    return s || null;
}

function licenseTextOf(dir: string): string | null {
    let names: string[];
    try {
        names = fs.readdirSync(dir).filter((n) => LICENSE_FILE.test(n));
    } catch {
        return null;
    }
    if (names.length === 0) return null;
    names.sort();
    const texts = names.map((n) => {
        const t = fs.readFileSync(path.join(dir, n), "utf8").replace(/\r\n/g, "\n").trim();
        return names.length > 1 ? `[${n}]\n${t}` : t;
    });
    return texts.join("\n\n");
}

function isWorkspace(m: Manifest, spec: string | undefined): boolean {
    return m.private === true || (spec?.startsWith("workspace:") ?? false);
}

export interface CollectOptions {
    /**
     * Packages to add to a workspace's seeds although it declares them as development
     * dependencies — their output ships (the Svelte runtime, the generated stylesheet).
     */
    extra?: Record<string, string[]>;
}

/**
 * Walks the production dependency closure of each workspace directory and returns one notice per
 * distinct installed package, sorted by name then version. The same package installed twice at
 * different versions appears twice — both ship.
 */
export function collectShippedPackages(
    workspaceDirs: string[],
    opts: CollectOptions = {},
): PackageNotice[] {
    const seen = new Map<string, PackageNotice>(); // keyed by realpath
    const visitedWorkspaces = new Set<string>();

    const visit = (dir: string, m: Manifest, isRoot: boolean): void => {
        const deps: Array<[string, string]> = Object.entries(m.dependencies ?? {});
        for (const [name, spec] of Object.entries(m.peerDependencies ?? {})) {
            // An optional peer that is not installed simply does not ship.
            if (m.peerDependenciesMeta?.[name]?.optional && !findPackageDir(dir, name)) continue;
            deps.push([name, spec]);
        }
        if (isRoot) {
            for (const name of opts.extra?.[path.basename(dir)] ?? []) deps.push([name, "*"]);
        }
        for (const [name, spec] of deps) {
            const depDir = findPackageDir(dir, name);
            if (!depDir) continue; // an optional peer, or a dependency the install skipped
            const dm = readManifest(depDir);
            if (!dm) continue;
            if (isWorkspace(dm, spec)) {
                if (visitedWorkspaces.has(depDir)) continue;
                visitedWorkspaces.add(depDir);
                visit(depDir, dm, false);
                continue;
            }
            if (seen.has(depDir)) continue;
            seen.set(depDir, {
                name: dm.name ?? name,
                version: dm.version ?? "0.0.0",
                license: licenseOf(dm),
                url: urlOf(dm),
                author: authorOf(dm),
                licenseText: licenseTextOf(depDir),
            });
            visit(depDir, dm, false);
        }
    };

    for (const ws of workspaceDirs) {
        const real = fs.realpathSync(ws);
        const m = readManifest(real);
        if (!m) throw new Error(`No package.json in ${ws}`);
        visitedWorkspaces.add(real);
        visit(real, m, true);
    }

    return [...seen.values()].sort((a, b) =>
        a.name === b.name ? cmp(a.version, b.version) : cmp(a.name, b.name),
    );
}

function cmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export interface RenderOptions {
    /** What this file is for — the first lines. */
    intro: string;
    /** Extra attribution for a package the manifest cannot express (fonts under another license, say). */
    notes?: Record<string, string>;
}

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

/** The notice file's text: a header, then one block per package with its license text. */
export function renderNotices(notices: PackageNotice[], opts: RenderOptions): string {
    const out: string[] = [opts.intro.trim(), "", `${notices.length} packages.`, ""];
    for (const n of notices) {
        out.push(RULE, `${n.name} ${n.version}`, `License: ${n.license}`);
        if (n.url) out.push(n.url);
        if (n.author) out.push(`Author: ${n.author}`);
        const note = opts.notes?.[n.name];
        if (note) out.push(`Note: ${note}`);
        out.push(THIN);
        out.push(
            n.licenseText ??
                `(The package ships no license file; the license is the one named above${n.author ? `, held by ${n.author}` : ""}.)`,
        );
        out.push("");
    }
    return `${out.join("\n")}\n`;
}

/** The product's own notices, shared by the web and API builds. */
export const ZKNOTES_INTRO = `ZKnotes — third-party notices

ZKnotes is free software under the GNU Affero General Public License v3.0 only; its own license
text is in LICENSE at the root of the source repository, and THIRD_PARTY_LICENSES.md there explains
why each license below is compatible with it. This file lists every package whose code or assets
ship in this build, with the license text each one carries. It is generated from the installed
packages when the build runs.`;

export const ZKNOTES_NOTES: Record<string, string> = {
    katex: "The KaTeX fonts (dist/fonts/*) are distributed under the SIL Open Font License 1.1; the code is MIT.",
    "svelte-toolbelt":
        "The package manifest names no license; the project publishes it under MIT (https://github.com/svecosystem/svelte-toolbelt).",
};

/** What ships from the client although it is declared as a development dependency. */
export const CLIENT_EXTRA: Record<string, string[]> = {
    client: ["svelte", "@sveltejs/kit", "tailwindcss"],
};
