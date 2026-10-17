// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "$lib/core/utils/dompurify";
import { makeShareFileChip } from "./share-file-chip";

describe("makeShareFileChip", () => {
    it("survives sanitizeHtml with download attrs", () => {
        const chip = makeShareFileChip("file-1", "doc.pdf", "application/pdf");
        const out = sanitizeHtml(chip.outerHTML);
        expect(out).toContain('data-share-file-id="file-1"');
        expect(out).toContain('data-share-download="true"');
        expect(out).toContain("share-file-download");
        expect(out).toContain("<svg");
        expect(out).toContain('stroke="currentColor"');
    });
});
