import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { classify, parseArgs, stripToRuntime } from "./check-comment-only";

/**
 * The gate is only worth having if it fails when it should. Every block below proves both
 * directions on the same input: a reworded comment must read as identical, and a code edit
 * on the very same file must read as different. A gate proven in one direction only is a gate
 * that can be green for the wrong reason.
 */

const TS_BEFORE = `
/** Fetches the wrapped key, opens it with the VK. */
export function unwrap(key: Uint8Array, wrapped: Uint8Array): Uint8Array {
    // nonce goes first, ciphertext after - never swap them
    return decrypt(key, wrapped.slice(24), wrapped.slice(0, 24));
}
`;

const TS_REWORDED = `
/** Reads the wrapped key and unwraps it with the Vault Key. */
export function unwrap(key: Uint8Array, wrapped: Uint8Array): Uint8Array {
    // Order matters: the nonce first, the ciphertext only after it.
    return decrypt(key, wrapped.slice(24), wrapped.slice(0, 24));
}
`;

/** One argument swapped — the kind of slip a comment-only pass must never smuggle in. */
const TS_CODE_CHANGED = TS_REWORDED.replace("wrapped.slice(24)", "wrapped.slice(23)");

const SVELTE_BEFORE = `<script lang="ts">
/** menu item - icon + label */
let { label, active = false } = $props();
</script>

<button class="row" class:active>{label}</button>
`;

const SVELTE_REWORDED = `<script lang="ts">
/** A single menu row: icon and label. */
let { label, active = false } = $props();
</script>

<button class="row" class:active>{label}</button>
`;

const SVELTE_CODE_CHANGED = SVELTE_REWORDED.replace('class="row"', 'class="row opacity-50"');

describe("comment-only gate — .ts", () => {
    it("reads a reworded comment as unchanged", async () => {
        const v = await classify("a.ts", TS_BEFORE, TS_REWORDED);
        expect(v.state).toBe("comment-only");
    });

    it("catches a code change hidden behind a reworded comment", async () => {
        const v = await classify("a.ts", TS_BEFORE, TS_CODE_CHANGED);
        expect(v.state).toBe("changed");
    });

    it("returns to green on a bit-identical revert", async () => {
        const v = await classify("a.ts", TS_BEFORE, TS_BEFORE);
        expect(v.state).toBe("comment-only");
    });

    it("strips comments rather than merely reformatting them", async () => {
        const out = await stripToRuntime("a.ts", TS_BEFORE);
        expect(out).not.toContain("Fetches");
        expect(out).not.toContain("never swap");
        expect(out).toContain("decrypt");
    });
});

describe("comment-only gate — .svelte", () => {
    it("reads a reworded comment as unchanged", async () => {
        const v = await classify("A.svelte", SVELTE_BEFORE, SVELTE_REWORDED);
        expect(v.state).toBe("comment-only");
    });

    it("catches a markup change", async () => {
        const v = await classify("A.svelte", SVELTE_BEFORE, SVELTE_CODE_CHANGED);
        expect(v.state).toBe("changed");
    });

    /**
     * The reason the .svelte path needs two steps at all: the compiler carries <script> comments
     * through to its output, so comparing compiled components directly would fail on any rewording.
     * If this ever starts passing, the second step has become unnecessary — check before removing it.
     */
    it("needs the second step, because the compiler leaks comments into its output", async () => {
        const require = createRequire(new URL("../client/package.json", import.meta.url));
        const { compile } = (await import(
            require.resolve("svelte/compiler")
        )) as typeof import("svelte/compiler");
        const raw = (s: string) =>
            compile(s, { filename: "A.svelte", generate: "client", dev: false }).js.code;
        expect(raw(SVELTE_BEFORE)).not.toBe(raw(SVELTE_REWORDED));
    });
});

describe("comment-only gate — honesty about its limits", () => {
    it("reports a file it cannot compile instead of passing it", async () => {
        const v = await classify("broken.svelte", SVELTE_BEFORE, "<script>{{{</script>");
        expect(v.state).toBe("unproven");
    });
});

describe("argument parsing", () => {
    it("treats bare paths as paths", () => {
        expect(parseArgs(["shared", "server"])).toEqual({
            base: "HEAD",
            paths: ["shared", "server"],
        });
    });

    it("reads --base and keeps the rest as paths", () => {
        expect(parseArgs(["--base", "HEAD~1", "shared"])).toEqual({
            base: "HEAD~1",
            paths: ["shared"],
        });
    });

    /**
     * `bun run script.ts -- shared` never passes the separator through. Dropping it here is what
     * keeps the same command working whether it is typed with `--` or without.
     */
    it("ignores a separator that survived, so both spellings scope the same way", () => {
        expect(parseArgs(["--", "shared"])).toEqual(parseArgs(["shared"]));
    });
});
