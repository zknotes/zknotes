// A structural guard for the sync layer: it reads the source of every module in core/sync and checks
// how they import each other. The engine is split by responsibility (wire, outbox, conflict, the
// push result, push, pull), and the split only holds while the dependencies point one way — a cycle
// between modules is exactly what brings a production chunk down at load time, where `vite dev`
// with its live bindings never shows it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = import.meta.dirname;

/**
 * The split modules and the sync modules each one may import (static, non-type imports only).
 * `push` and `pull` never import each other, and `pull` does not need the push result either; a
 * helper both sides need goes down into `wire` or `outbox`. `engine` is the public facade on top.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    wire: [],
    outbox: ["store.svelte"],
    conflict: ["outbox"],
    "push-result": ["wire", "outbox", "conflict", "store.svelte"],
    push: ["wire", "outbox", "conflict", "push-result", "store.svelte", "sync-lock"],
    pull: ["wire", "outbox", "conflict", "store.svelte", "sync-lock"],
    engine: ["outbox", "push-result", "push", "pull"],
};

// `import … from "x"` and `export … from "x"`, anchored at the start of a line so a dynamic
// `await import("x")` or a mention in a comment does not count. Group 1 is set for `import type` /
// `export type`, which the compiler erases (`verbatimModuleSyntax`) — those are not runtime edges.
const STATIC_FROM =
    /^(?:import|export)\s+(type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s+from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT = /^import\s+["']([^"']+)["']/gm;

/** The name of the sync module a specifier points at, or null when it points outside core/sync. */
function syncModuleOf(specifier: string): string | null {
    const local =
        specifier.match(/^\.\/(.+)$/)?.[1] ?? specifier.match(/^\$lib\/core\/sync\/(.+)$/)?.[1];
    if (local !== undefined) return local.replace(/\.(ts|js)$/, "");
    return specifier === "$lib/core/sync" ? "index" : null;
}

/** Every non-test module in core/sync, by name (`store.svelte.ts` → `store.svelte`), with its source. */
function readSyncModules(): Map<string, string> {
    const modules = new Map<string, string>();
    for (const file of readdirSync(DIR)) {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
        modules.set(file.replace(/\.ts$/, ""), readFileSync(join(DIR, file), "utf8"));
    }
    return modules;
}

/** module → the sync modules it imports at runtime. */
function buildGraph(modules: Map<string, string>): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();
    for (const [name, source] of modules) {
        const deps = new Set<string>();
        for (const m of source.matchAll(STATIC_FROM)) {
            const target = m[1] ? null : syncModuleOf(m[2] ?? "");
            if (target) deps.add(target);
        }
        for (const m of source.matchAll(SIDE_EFFECT)) {
            const target = syncModuleOf(m[1] ?? "");
            if (target) deps.add(target);
        }
        graph.set(name, deps);
    }
    return graph;
}

/** The first import cycle found, as a path that starts and ends on the same module, or null. */
function findCycle(graph: Map<string, Set<string>>): string[] | null {
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];
    const visit = (node: string): string[] | null => {
        if (state.get(node) === "done") return null;
        if (state.get(node) === "visiting") return [...stack.slice(stack.indexOf(node)), node];
        state.set(node, "visiting");
        stack.push(node);
        for (const dep of graph.get(node) ?? []) {
            const cycle = visit(dep);
            if (cycle) return cycle;
        }
        stack.pop();
        state.set(node, "done");
        return null;
    };
    for (const node of graph.keys()) {
        const cycle = visit(node);
        if (cycle) return cycle;
    }
    return null;
}

describe("the sync module graph", () => {
    const modules = readSyncModules();
    const graph = buildGraph(modules);

    it("sees the imports that are known to exist (the parser is not blind)", () => {
        expect(graph.get("conflict")).toContain("outbox");
        expect(graph.get("engine")).toContain("outbox");
        expect(graph.get("scheduler")).toContain("engine");
        expect(graph.get("index")).toContain("engine");
    });

    it("has no import cycle between sync modules", () => {
        expect(findCycle(graph)).toBeNull();
    });

    it("lets each split module import only the modules below it", () => {
        const violations: string[] = [];
        for (const [name, allowed] of Object.entries(ALLOWED)) {
            for (const dep of graph.get(name) ?? []) {
                if (!allowed.includes(dep)) violations.push(`${name} → ${dep}`);
            }
        }
        expect(violations).toEqual([]);
    });

    it("keeps engine.ts a facade of named re-exports", () => {
        // `export *` would also re-export the helpers the modules share with each other, and
        // index.ts passes everything engine exports on to `$lib/core/sync`.
        const source = modules.get("engine") ?? "";
        const leftover = source
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "")
            .replace(/^export\s+\{[^}]*\}\s+from\s+"\.\/[^"]+";$/gm, "")
            .trim();
        expect(source).toMatch(/^export\s+\{/m);
        expect(leftover).toBe("");
    });

    it("never imports modules/export from a sync module", () => {
        // A restore's UI-key cleanup is shared through core/utils (clear-vault-ui-keys), not by
        // reaching into the export module from the sync layer.
        const offenders = [...modules]
            .filter(([, source]) => /\$lib\/modules\/export/.test(source))
            .map(([name]) => name);
        expect(offenders).toEqual([]);
    });

    it("never statically imports $lib/modules from core/sync or core/services", () => {
        // The golden rule of imports (events/file-bridge.ts): core must not reach into modules/.
        // A dynamic `await import("$lib/modules/…")` behind a bridge is the sanctioned exception,
        // and `STATIC_FROM` ignores it. This used to check only modules/export, so two static imports
        // of modules/files/refs sat in conflict.ts and item-service.ts unnoticed.
        const offenders: string[] = [];
        for (const dir of [DIR, join(DIR, "..", "services")]) {
            for (const file of readdirSync(dir)) {
                if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".d.ts")) {
                    continue;
                }
                const source = readFileSync(join(dir, file), "utf8");
                for (const m of source.matchAll(STATIC_FROM)) {
                    if (!m[1] && (m[2] ?? "").startsWith("$lib/modules/")) {
                        offenders.push(`${file} → ${m[2]}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
