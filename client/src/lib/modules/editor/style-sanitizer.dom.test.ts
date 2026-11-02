import { describe, expect, it } from "vitest";
import { sanitizeEditorStyles, sanitizeStyleDeclarations } from "./style-sanitizer";

describe("sanitizeStyleDeclarations", () => {
    it("keeps the editor's own properties with well-formed values", () => {
        expect(sanitizeStyleDeclarations("color: #ff0000; font-size: 14px")).toBe(
            "color: #ff0000; font-size: 14px",
        );
        expect(sanitizeStyleDeclarations("background-color: rgba(255, 0, 0, 0.5)")).toBe(
            "background-color: rgba(255, 0, 0, 0.5)",
        );
        expect(sanitizeStyleDeclarations("text-align: center; width: 50%")).toBe(
            "text-align: center; width: 50%",
        );
    });

    it("drops unknown properties and values that smuggle more CSS", () => {
        expect(sanitizeStyleDeclarations("background: url(https://x/pixel.gif)")).toBeNull();
        expect(sanitizeStyleDeclarations("color: red; position: fixed; top: 0")).toBe("color: red");
        expect(sanitizeStyleDeclarations("color: red url(x)")).toBeNull();
        expect(sanitizeStyleDeclarations("font-family: url(x)")).toBeNull();
        expect(sanitizeStyleDeclarations("color: expression(alert(1))")).toBeNull();
    });
});

describe("sanitizeEditorStyles", () => {
    it("filters styles and highlight colours in place and leaves the rest of the HTML alone", () => {
        const html =
            '<p style="text-align: center"><span style="color: #0f0; background: url(x)">a</span>' +
            '<mark data-color="red; background: url(x)">b</mark><mark data-color="#ffff00">c</mark></p>';
        expect(sanitizeEditorStyles(html)).toBe(
            '<p style="text-align: center"><span style="color: #0f0">a</span><mark>b</mark>' +
                '<mark data-color="#ffff00">c</mark></p>',
        );
    });

    it("takes class, target and rel off links — the editor sets its own", () => {
        expect(
            sanitizeEditorStyles(
                '<p><a href="https://e.x" class="btn" target="_top" rel="">x</a></p>',
            ),
        ).toBe('<p><a href="https://e.x">x</a></p>');
    });

    it("returns HTML with nothing to filter unchanged", () => {
        const html = "<p>plain <strong>text</strong></p>";
        expect(sanitizeEditorStyles(html)).toBe(html);
    });
});
