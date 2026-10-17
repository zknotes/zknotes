/**
 * A check that the public repository can build ON ITS OWN — with not a single private dependency,
 * private registry or token in the build graph.
 *
 * Why it exists: the Bitwarden episode of 2024 — the source was published and the licence was in
 * order, but a build could no longer be made from the public code, so publishing it had lost its
 * point. For a zero-knowledge product that is worse than a bad impression: anyone who
 * cannot build the client themselves cannot check that this is the code we are serving them.
 *
 * This is a STATIC check of the graph and it runs in every `./check.sh`. Alongside it, CI builds the
 * client in a clean container — which catches what a manifest does not admit to.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

type Finding = { file: string; reason: string };
const findings: Finding[] = [];

/** The directories we do not search (installed packages, build output, git). */
const SKIP = new Set(["node_modules", ".git", "build", "dist", ".svelte-kit", "test-results"]);

function walk(dir: string, out: string[] = []): string[] {
    // `withFileTypes` describes the entry itself, not what a symlink points at — which is the
    // difference this gate depends on. Symlinks are never followed: one pointing outside the
    // repository would pull foreign files into a check whose entire job is to describe *this*
    // repository's build graph, and a manifest read from the other side of such a link would be
    // indistinguishable from a real violation.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

const files = walk(ROOT);
const manifests = files.filter((f) => f.endsWith("package.json"));
const rcFiles = files.filter((f) => f.endsWith(".npmrc") || f.endsWith("bunfig.toml"));

/** The workspaces declared in the root manifest — a `workspace:` may point only at these. */
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const workspaces: string[] = rootPkg.workspaces ?? [];

// ── 1. The dependency specifications ─────────────────────────────────────────
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

for (const file of manifests) {
    const rel = relative(ROOT, file);
    let pkg: Record<string, unknown>;
    try {
        pkg = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        continue;
    }

    for (const field of DEP_FIELDS) {
        const deps = pkg[field] as Record<string, string> | undefined;
        if (!deps) continue;

        for (const [name, spec] of Object.entries(deps)) {
            if (typeof spec !== "string") continue;

            // `file:`/`link:` may point only INSIDE the repository. A `file:../<private repo>/...` is
            // exactly what this check forbids: the public build would ask for a tree the published
            // repository does not have.
            if (spec.startsWith("file:") || spec.startsWith("link:")) {
                const target = resolve(dirname(file), spec.replace(/^(file|link):/, ""));
                if (!target.startsWith(ROOT + "/") && target !== ROOT) {
                    findings.push({
                        file: rel,
                        reason: `"${name}": "${spec}" resolves outside the repository (${relative(ROOT, target)})`,
                    });
                }
            }

            // `workspace:` does not cross a repository boundary: bun looks for it in ITS OWN tree,
            // so the build fails only at the consumer.
            if (spec.startsWith("workspace:")) {
                const known =
                    workspaces.some((w) => name.endsWith(`/${w}`) || name === w) ||
                    workspaces.some((w) => {
                        try {
                            const m = JSON.parse(
                                readFileSync(join(ROOT, w, "package.json"), "utf8"),
                            );
                            return m.name === name;
                        } catch {
                            return false;
                        }
                    });
                if (!known) {
                    findings.push({
                        file: rel,
                        reason: `"${name}": "${spec}" is not one of the declared workspaces (${workspaces.join(", ")})`,
                    });
                }
            }

            // A git dependency may be private, and even when it is not, the build depends on someone else's host.
            if (/^(git\+|git:|github:|bitbucket:|gitlab:)/.test(spec)) {
                findings.push({ file: rel, reason: `"${name}": "${spec}" is a git dependency` });
            }

            // A tarball from an arbitrary host — the same problem.
            if (/^https?:\/\//.test(spec)) {
                findings.push({
                    file: rel,
                    reason: `"${name}": "${spec}" is fetched over HTTP(S)`,
                });
            }
        }
    }
}

// ── 2. The registry configuration ────────────────────────────────────────────
for (const file of rcFiles) {
    const rel = relative(ROOT, file);
    for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        // Any registry that is not the public npm.
        const registry = trimmed.match(/registry\s*=\s*"?([^"\s]+)/i);
        if (registry?.[1] && !/^https?:\/\/registry\.npmjs\.org\/?$/.test(registry[1])) {
            findings.push({
                file: `${rel}:${i + 1}`,
                reason: `non-public registry: ${registry[1]}`,
            });
        }
        // A token in a tracked file is a secret and a private dependency at once.
        if (/_authToken|_auth\s*=|_password\s*=/i.test(trimmed)) {
            findings.push({
                file: `${rel}:${i + 1}`,
                reason: "registry credential in a tracked file",
            });
        }
    }
}

// ── Output ───────────────────────────────────────────────────────────────────
console.log("▶ Clean build — no private dependencies, registries or tokens in the graph");

if (findings.length === 0) {
    console.log(
        `✓ Clean build gate — OK (${manifests.length} manifests, ${rcFiles.length} rc files)`,
    );
    process.exit(0);
}

for (const f of findings) console.log(`  ✗ ${f.file}: ${f.reason}`);
console.log(`✗ Clean build gate — ${findings.length} problem(s)`);
console.log("  The public repository must build on its own — see LICENSE and CONTRIBUTING.md.");
process.exit(1);
