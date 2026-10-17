// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./html-to-md";

describe("htmlToMarkdown — headings", () => {
    it("h1 → # Title", () => {
        expect(htmlToMarkdown("<h1>Title</h1>")).toContain("# Title");
    });

    it("h2 → ## Sub", () => {
        expect(htmlToMarkdown("<h2>Sub</h2>")).toContain("## Sub");
    });

    it("h3 → ### Heading", () => {
        expect(htmlToMarkdown("<h3>Third</h3>")).toContain("### Third");
    });
});

describe("htmlToMarkdown — inline formatting", () => {
    it("<strong> → **bold**", () => {
        expect(htmlToMarkdown("<p><strong>bold</strong></p>")).toContain("**bold**");
    });

    it("<em> → _italic_", () => {
        expect(htmlToMarkdown("<p><em>italic</em></p>")).toContain("_italic_");
    });

    it("<s> → ~~strike~~", () => {
        expect(htmlToMarkdown("<p><s>strike</s></p>")).toContain("~~strike~~");
    });

    it("inline <code> → `code`", () => {
        expect(htmlToMarkdown("<p><code>inline</code></p>")).toContain("`inline`");
    });

    it("<pre><code> → code block", () => {
        const result = htmlToMarkdown("<pre><code>block</code></pre>");
        expect(result).toContain("```");
        expect(result).toContain("block");
    });
});

describe("htmlToMarkdown — links and images", () => {
    it("<a href> → [text](url)", () => {
        expect(htmlToMarkdown('<a href="https://example.com">link</a>')).toContain(
            "[link](https://example.com)",
        );
    });

    it("<img src> → ![alt](src)", () => {
        expect(htmlToMarkdown('<img src="img.png" alt="image">')).toContain("![image](img.png)");
    });

    it("<img data-file-id> → ![alt](./_attachments/id)", () => {
        expect(htmlToMarkdown('<img data-file-id="abc123" alt="attachment">')).toContain(
            "![attachment](./_attachments/abc123)",
        );
    });

    it("<img src=data:> → ![alt](_image_embedded)", () => {
        expect(htmlToMarkdown('<img src="data:image/png;base64,abc" alt="x">')).toContain(
            "![x](_image_embedded)",
        );
    });
});

describe("htmlToMarkdown — lists", () => {
    it("<ul> → an unordered list with '- '", () => {
        const result = htmlToMarkdown("<ul><li>a</li><li>b</li></ul>");
        expect(result).toContain("- a");
        expect(result).toContain("- b");
    });

    it("<ol> → an ordered list with numbers", () => {
        const result = htmlToMarkdown("<ol><li>first</li><li>second</li></ol>");
        expect(result).toContain("1. first");
        expect(result).toContain("2. second");
    });
});

describe("htmlToMarkdown — tables", () => {
    it("a 2x2 table → a markdown table with a header separator", () => {
        const html = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
        const result = htmlToMarkdown(html);
        expect(result).toContain("| A | B |");
        expect(result).toContain("| --- | --- |");
        expect(result).toContain("| 1 | 2 |");
    });
});

describe("htmlToMarkdown — the rest", () => {
    it("<blockquote> → > quoted", () => {
        const result = htmlToMarkdown("<blockquote><p>quote</p></blockquote>");
        expect(result).toContain("> ");
    });

    it("<hr> → ---", () => {
        expect(htmlToMarkdown("<hr>")).toContain("---");
    });

    it("an empty string → ''", () => {
        expect(htmlToMarkdown("")).toBe("");
    });

    it("whitespace only → ''", () => {
        expect(htmlToMarkdown("   ")).toBe("");
    });

    it("pipe characters in a table are escaped", () => {
        const html = "<table><tr><th>A|B</th></tr></table>";
        const result = htmlToMarkdown(html);
        expect(result).toContain("A\\|B");
    });

    it("backslashes before a pipe in a table are escaped too, so the pipe cannot split the cell", () => {
        // Cell text: a\|b and c\\|d — each literal backslash becomes \\, the pipe becomes \|.
        const html = "<table><tr><th>a\\|b</th><th>c\\\\|d</th></tr></table>";
        const result = htmlToMarkdown(html);
        expect(result).toContain("| a\\\\\\|b | c\\\\\\\\\\|d |");
    });

    it("backslashes not before a pipe stay as they are", () => {
        const html = "<table><tr><td>C:\\temp</td><td><code>C:\\temp</code></td></tr></table>";
        const result = htmlToMarkdown(html);
        expect(result).toContain("| C:\\temp | `C:\\temp` |");
    });
});
