/**
 * Proves that a change touched only comments — that no behaviour moved with it.
 *
 * Why it exists: translating ~4000 lines of comments across ~420 files is not reviewable by
 * reading. Without a mechanical proof, "this commit only changed comments" is a claim; with one,
 * it is a fact, and an outside contributor sending a translation PR can produce the same evidence.
 *
 * How it works: strip every comment from both revisions, then compare. Identical output means the
 * runtime is identical, whatever happened to the prose.
 *
 *   .ts / .js   TypeScript's own transpiler, with removeComments, drops comments and types.
 *   .svelte     The Svelte compiler LEAKS <script> comments into the emitted JS, so hashing a
 *               compiled component is not proof on its own (verified: the hash moves when only a
 *               comment is translated). Compile first, then strip comments from the result.
 *
 * Two known blind spots, stated rather than hidden:
 *   1. Type-only edits vanish with the annotations. `tsc` in ./check.sh covers that ground.
 *   2. Legal comments (the /*! form) survive transpilation, so editing one reads as a change.
 *      That fails safe — a false alarm, never a miss — and this repository has none today.
 *
 * Anything that is not .ts/.js/.svelte has no mechanical proof here. Such files are listed as
 * unproven instead of being counted as passing; their evidence is ./test.sh plus review.
 *
 * Usage:
 *   bun run scripts/check-comment-only.ts                  # working tree vs HEAD
 *   bun run scripts/check-comment-only.ts --base HEAD~1    # a commit that was already made
 *   bun run scripts/check-comment-only.ts -- shared server # restrict to paths
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// `import.meta.dir` is Bun-only and this module is also loaded by vitest, which is not Bun.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");

/** Extensions this gate can prove. Everything else is reported as unproven. */
const PROVABLE = /\.(ts|js|mjs|svelte)$/;

type Verdict = {
    file: string;
    state: "comment-only" | "changed" | "unproven";
    /** Why it could not be proven, when that is the verdict. */
    note?: string;
};

function git(args: string[]): { ok: boolean; out: string } {
    const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** File content at a revision, or null when the path does not exist there. */
function blobAt(ref: string, file: string): string | null {
    const r = git(["show", `${ref}:${file}`]);
    return r.ok ? r.out : null;
}

let compileSvelte: ((source: string, filename: string) => string) | null = null;

/** Svelte lives in the client workspace, not at the root, so it is resolved from there. */
async function svelteToJs(source: string, filename: string): Promise<string> {
    if (!compileSvelte) {
        const require = createRequire(`${ROOT}/client/package.json`);
        const { compile } = (await import(
            require.resolve("svelte/compiler")
        )) as typeof import("svelte/compiler");
        compileSvelte = (src, name) =>
            compile(src, { filename: name, generate: "client", dev: false }).js.code;
    }
    return compileSvelte(source, filename);
}

/**
 * Comments and type annotations removed. `typescript` rather than `Bun.Transpiler` on purpose:
 * ./test.sh runs vitest under Node, where the Bun global does not exist, and the gate has to be
 * runnable by an outside contributor who has no Bun at all.
 */
function stripComments(source: string, fileName: string): string {
    return ts.transpileModule(source, {
        fileName,
        compilerOptions: {
            removeComments: true,
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
}

/**
 * Source reduced to what actually runs: comments gone, types gone, formatting normalised.
 * Exported because this is the part worth testing directly (see the sibling test file).
 */
export async function stripToRuntime(file: string, source: string): Promise<string> {
    if (file.endsWith(".svelte")) {
        return stripComments(await svelteToJs(source, file), `${file}.js`);
    }
    return stripComments(source, file);
}

export async function classify(file: string, before: string, after: string): Promise<Verdict> {
    try {
        const a = await stripToRuntime(file, before);
        const b = await stripToRuntime(file, after);
        return { file, state: a === b ? "comment-only" : "changed" };
    } catch (err) {
        // A file that will not compile cannot be proven either way. Say so; do not pass it.
        return { file, state: "unproven", note: `compile failed — ${(err as Error).message}` };
    }
}

/**
 * Everything that is not a recognised flag is a path. A bare `--` is accepted and skipped, because
 * `bun run script.ts -- shared` swallows the separator before the script ever sees it — a silently
 * ignored path filter would run the gate over the whole tree while looking like it had not.
 */
export function parseArgs(argv: string[]): { base: string; paths: string[] } {
    let base = "HEAD";
    const paths: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") continue;
        if (arg === "--base") {
            base = argv[++i] ?? "HEAD";
            continue;
        }
        if (arg !== undefined) paths.push(arg);
    }
    return { base, paths };
}

async function main(): Promise<number> {
    const { base, paths } = parseArgs(process.argv.slice(2));

    const scope = paths.length > 0 ? ` — paths: ${paths.join(", ")}` : "";
    console.log(`▶ Comment-only gate — working tree vs ${base}${scope}`);

    const diff = git(["diff", "--name-only", base, "--", ...paths]);
    if (!diff.ok) {
        console.error(`✗ Comment-only gate — cannot diff against '${base}'`);
        return 1;
    }

    const files = diff.out.split("\n").filter(Boolean);
    if (files.length === 0) {
        console.log(`✓ Comment-only gate — no changes against ${base}`);
        return 0;
    }

    const verdicts: Verdict[] = [];
    for (const file of files) {
        if (!PROVABLE.test(file)) {
            verdicts.push({ file, state: "unproven", note: "no mechanical proof for this type" });
            continue;
        }
        const before = blobAt(base, file);
        const after = await Bun.file(`${ROOT}/${file}`)
            .text()
            .catch(() => null);
        if (before === null || after === null) {
            const note = before === null ? "added — nothing to compare against" : "deleted";
            verdicts.push({ file, state: "unproven", note });
            continue;
        }
        verdicts.push(await classify(file, before, after));
    }

    const proven = verdicts.filter((v) => v.state === "comment-only");
    const changed = verdicts.filter((v) => v.state === "changed");
    const unproven = verdicts.filter((v) => v.state === "unproven");

    for (const v of changed) console.log(`  ✗ ${v.file} — code changed`);
    for (const v of unproven) console.log(`  ? ${v.file} — ${v.note}`);

    const svelte = proven.filter((v) => v.file.endsWith(".svelte")).length;
    console.log(
        `  proven comment-only: ${proven.length} (${proven.length - svelte} ts/js, ${svelte} svelte)`,
    );
    if (unproven.length > 0) {
        console.log(
            `  unproven: ${unproven.length} — evidence is ./test.sh and review, not this gate`,
        );
    }

    if (changed.length > 0) {
        console.log(`✗ Comment-only gate — ${changed.length} file(s) changed behaviour`);
        return 1;
    }
    console.log(`✓ Comment-only gate — OK (${proven.length} file(s) proven against ${base})`);
    return 0;
}

// Bun sets `import.meta.main`; under Node it is undefined, which is what keeps vitest from
// running the CLI on import.
if (import.meta.main) process.exit(await main());
