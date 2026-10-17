// @vitest-environment jsdom
// DOMPurify + happy-dom can strip heading tags; jsdom is the source of truth, as in dompurify.test.ts.
import { describe, expect, it } from "vitest";
import { importMarkdownToHtml } from "./markdown-import";

describe("importMarkdownToHtml", () => {
    it("turns ordinary markdown into HTML", () => {
        const html = importMarkdownToHtml("# Hello\n\n**bold**");
        expect(html).toMatch(/<h1[^>]*>Hello<\/h1>/);
        expect(html).toMatch(/<(strong|b)>bold<\/(strong|b)>/);
    });

    it("$$block$$ → a display math span", () => {
        const html = importMarkdownToHtml("before\n\n$$E = mc^2$$\n\nafter");
        expect(html).toContain('data-type="inlineMath"');
        expect(html).toContain('data-display="yes"');
        expect(html).toContain("E = mc^2");
    });

    it("$inline$ latex → inline math", () => {
        const html = importMarkdownToHtml("formula $x^2$ here");
        expect(html).toContain('data-type="inlineMath"');
        expect(html).toContain('data-display="no"');
        expect(html).toContain("x^2");
    });

    it("an escaped \\$ does not become math", () => {
        const html = importMarkdownToHtml("price \\$5");
        expect(html).not.toContain("inlineMath");
        expect(html).toMatch(/\$5|&#36;5|\\\$5/);
    });

    it('two prices on one line ("costs $5 or $10") do not become inline math', () => {
        const html = importMarkdownToHtml("costs $5 or $10");
        expect(html).not.toContain("inlineMath");
        expect(html).not.toContain("data-latex");
        expect(html).toContain("$5");
        expect(html).toContain("$10");
    });

    it("a bare $5$ is not math (it is a currency)", () => {
        const html = importMarkdownToHtml("only $5$ dollars");
        expect(html).not.toContain("inlineMath");
    });

    it("strips script tags (sanitizeHtml)", () => {
        const html = importMarkdownToHtml("<script>alert(1)</script>\n\n# ok");
        expect(html).not.toMatch(/<script/i);
        expect(html).toMatch(/ok/i);
    });

    it("does not mutate the global marked.use (a scoped instance)", async () => {
        const { marked } = await import("marked");
        const before = marked.defaults;
        importMarkdownToHtml("$x$");
        // the global defaults object stays the same by reference (the scoped Marked leaves it alone)
        expect(marked.defaults).toBe(before);
    });
});
