// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "$lib/core/utils/dompurify";
import { countInternalNoteLinks, neutralizeInternalNoteLinks } from "./share-note-links";

describe("countInternalNoteLinks", () => {
    it("counts unique note ids", () => {
        const html =
            '<p><a data-note-id="a">@One</a> and <a data-note-id="b">@Two</a> and <a data-note-id="a">@One again</a></p>';
        expect(countInternalNoteLinks(html)).toBe(2);
    });

    it("returns 0 when no internal links", () => {
        expect(countInternalNoteLinks("<p>plain text</p>")).toBe(0);
    });
});

describe("neutralizeInternalNoteLinks", () => {
    it("replaces anchors with non-clickable spans", () => {
        const html =
            '<p>See <a href="/note/abc" data-note-id="abc" class="note-link">@Related</a></p>';
        const out = neutralizeInternalNoteLinks(html);
        expect(out).not.toContain("<a ");
        expect(out).toContain('class="share-note-ref"');
        expect(out).toContain("@Related");
        expect(out).toContain('title="Not included in this share"');
    });

    it("survives sanitizeHtml", () => {
        const html = '<a href="/note/x" data-note-id="x" class="note-link">@Note</a>';
        const out = sanitizeHtml(neutralizeInternalNoteLinks(html));
        expect(out).toContain("share-note-ref");
        expect(out).not.toContain("data-note-id");
        expect(out).not.toContain('href="');
    });
});
