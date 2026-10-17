import { describe, expect, it } from "vitest";
import { extractPlainText } from "./tiptap-text";

describe("extractPlainText — HTML input", () => {
    it("an empty string → ''", () => {
        expect(extractPlainText("")).toBe("");
    });

    it("<p>Hello</p> → 'Hello'", () => {
        expect(extractPlainText("<p>Hello</p>")).toBe("Hello");
    });

    it("<h1> and <p> together → joined with a space", () => {
        const result = extractPlainText("<h1>Title</h1><p>Text</p>");
        expect(result).toContain("Title");
        expect(result).toContain("Text");
    });

    it("<img> tags are ignored (they carry no text)", () => {
        const result = extractPlainText('<p>Text</p><img src="x.png" alt="a picture">');
        expect(result).toBe("Text");
    });

    it("a <script> block is removed completely", () => {
        const result = extractPlainText("<p>ok</p><script>alert(1)</script>");
        expect(result).toBe("ok");
        expect(result).not.toContain("alert");
    });

    it("a <style> block is removed completely", () => {
        const result = extractPlainText("<p>ok</p><style>body { color: red; }</style>");
        expect(result).toBe("ok");
        expect(result).not.toContain("color");
    });

    it("HTML entities are decoded", () => {
        const result = extractPlainText("<p>&amp; &lt; &gt; &quot; &nbsp; &#39;</p>");
        expect(result).toContain("&");
        expect(result).toContain("<");
        expect(result).toContain(">");
        expect(result).toContain('"');
        expect(result).toContain("'");
    });

    it("an entity typed as text is decoded only once", () => {
        // The note's text is literally "&lt;b&gt;"; the editor stores it as "&amp;lt;b&amp;gt;".
        expect(extractPlainText("<p>&amp;lt;b&amp;gt; &amp;amp;</p>")).toBe("&lt;b&gt; &amp;");
    });

    it("several spaces or newlines → one space", () => {
        const result = extractPlainText("<p>a</p><p>b</p>");
        expect(result).toMatch(/^a\s+b$|^a b$/);
        expect(result.trim().split(/\s+/).length).toBe(2);
    });

    it("a string longer than 50,000 characters → truncated to 50,000", () => {
        const longText = "a".repeat(60_000);
        const result = extractPlainText(`<p>${longText}</p>`);
        expect(result.length).toBeLessThanOrEqual(50_000);
    });

    it("internal note link (a.note-link) → '@Note Title'", () => {
        const result = extractPlainText(
            '<p>See <a href="/note/123" data-note-id="123" class="note-link">@My Note</a></p>',
        );
        expect(result).toBe("See @My Note");
    });
});

describe("extractPlainText — TipTap JSON object", () => {
    it("a doc with a single text node", () => {
        const doc = {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
        };
        const result = extractPlainText(doc);
        expect(result).toContain("Hello");
    });

    it("an image node is skipped", () => {
        const doc = {
            type: "doc",
            content: [
                { type: "paragraph", content: [{ type: "text", text: "Text" }] },
                { type: "image", attrs: { src: "data:image/png;base64,abc" } },
            ],
        };
        const result = extractPlainText(doc);
        expect(result).toContain("Text");
        expect(result).not.toContain("data:image");
    });

    it("nested content is joined correctly", () => {
        const doc = {
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    content: [
                        { type: "text", text: "One" },
                        { type: "text", text: "Two" },
                    ],
                },
            ],
        };
        const result = extractPlainText(doc);
        expect(result).toContain("One");
        expect(result).toContain("Two");
    });

    it("a mention node turns into '@Label'", () => {
        const doc = {
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    content: [
                        { type: "text", text: "Have a look at " },
                        { type: "mention", attrs: { id: "123", label: "My Note" } },
                    ],
                },
            ],
        };
        const result = extractPlainText(doc);
        expect(result).toBe("Have a look at @My Note");
    });
});

describe("extractPlainText — edge cases", () => {
    it("null → ''", () => {
        expect(extractPlainText(null)).toBe("");
    });

    it("undefined → ''", () => {
        expect(extractPlainText(undefined)).toBe("");
    });

    it("a number → ''", () => {
        expect(extractPlainText(42)).toBe("");
    });
});
