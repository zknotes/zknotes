import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The seal's user-facing text names no ledger technology: "existed before", "public ledger",
 * never "Bitcoin" or "blockchain" (spec 169 §3). The two exceptions are the one-time
 * irreversibility confirmation (SealDialog.svelte) and VERIFY.txt (seal-export.ts), which has to
 * name the tools a verifier runs.
 */
const UI_SOURCES = ["SealSection.svelte", "SealBadge.svelte", "seal-pdf.ts"];

describe("seal copy", () => {
    it.each(UI_SOURCES)("%s does not name the ledger", (name) => {
        const text = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
        expect(text).not.toMatch(/bitcoin|blockchain/i);
    });
});
