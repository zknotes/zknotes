import { describe, expect, it } from "vitest";
import { uniquePath } from "./utils";

// Saas spec 157: the HTML and Markdown exports used two different implementations of the same rule.
describe("uniquePath", () => {
    it("hands out (2), (3)… for a taken name and records what it gave", () => {
        const used = new Set<string>();
        expect(uniquePath("A/Note", ".md", used)).toBe("A/Note.md");
        expect(uniquePath("A/Note", ".md", used)).toBe("A/Note (2).md");
        expect(uniquePath("A/Note", ".md", used)).toBe("A/Note (3).md");
        expect(uniquePath("A/Note", ".html", used)).toBe("A/Note.html");
        expect([...used]).toHaveLength(4);
    });
});
