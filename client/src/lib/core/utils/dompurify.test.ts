// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeHtml, sanitizeShareHtml, sanitizeSvg } from "./dompurify";

describe("DOMPurify wrapper", () => {
    it("HTML: allows the standard formatting elements", () => {
        const input = `<p>This is <strong>bold</strong> and <em>italic</em>.</p>`;
        expect(sanitizeHtml(input)).toBe(input);
    });

    it("HTML: blocks <script> tags", () => {
        const input = `<p>Test</p><script>alert('XSS')</script>`;
        expect(sanitizeHtml(input)).toBe("<p>Test</p>");
    });

    it("HTML: allows TipTap tables", () => {
        const input = `<table><tbody><tr><th colspan="2" rowspan="1" colwidth="100,200">Header</th></tr></tbody></table>`;
        expect(sanitizeHtml(input)).toBe(input);
    });

    it("HTML: removes disallowed attributes such as onmouseover", () => {
        const input = `<a href="https://example.com" onmouseover="alert('XSS')">Link</a>`;
        expect(sanitizeHtml(input)).toBe(`<a href="https://example.com">Link</a>`);
    });

    it("HTML: allows data-file-id", () => {
        const input = `<img src="blob:http://localhost/123" data-file-id="abc">`;
        expect(sanitizeHtml(input)).toBe(input);
    });

    it("HTML: cleans href='javascript:...'", () => {
        const input = `<a href="javascript:alert(1)">Click</a>`;
        // DOMPurify blocks javascript: protocols by default. We expect the href to disappear.
        expect(sanitizeHtml(input)).toBe(`<a>Click</a>`);
    });

    it("SVG: keeps the basic SVG structure", () => {
        const input = `<svg width="100" height="100"><circle cx="50" cy="50" r="40" stroke="green" stroke-width="4" fill="yellow" /></svg>`;
        const expected = `<svg width="100" height="100"><circle cx="50" cy="50" r="40" stroke="green" stroke-width="4" fill="yellow"></circle></svg>`;
        expect(sanitizeSvg(input)).toBe(expected);
    });

    it("SVG: removes <script> from SVG files", () => {
        const input = `<svg><script>alert(1)</script><circle r="10"/></svg>`;
        // The script tag should be removed
        expect(sanitizeSvg(input)).toBe(`<svg><circle r="10"></circle></svg>`);
    });

    it("SVG: removes inline event handlers such as onload", () => {
        const input = `<svg onload="alert(1)"><circle r="10"/></svg>`;
        expect(sanitizeSvg(input)).toBe(`<svg><circle r="10"></circle></svg>`);
    });

    it("share sanitizer strips remote image and style URLs", () => {
        const withRemoteImg = `<p>hi</p><img src="https://evil.example/px?id=1" alt="x">`;
        const cleanedImg = sanitizeShareHtml(withRemoteImg);
        expect(cleanedImg).not.toContain("evil.example");
        expect(cleanedImg).not.toMatch(/src=["']https?:/i);

        const withBlob = `<img src="blob:https://app.zknotes.eu/abc" data-file-id="f1">`;
        expect(sanitizeShareHtml(withBlob)).toContain("blob:");

        const withStyle = `<span style="background:url(https://evil.example/px)">x</span>`;
        const cleanedStyle = sanitizeShareHtml(withStyle);
        expect(cleanedStyle).not.toContain("style");
        expect(cleanedStyle).not.toContain("evil.example");

        const blank = `<a href="https://example.com" target="_blank">go</a>`;
        const cleanedA = sanitizeShareHtml(blank);
        expect(cleanedA).toContain('rel="noopener noreferrer"');
    });

    it("table width: style is stripped; data-user-width survives in a note and a share", () => {
        const table = `<table style="width: 60%" data-user-width="60%"><tr><td>a</td></tr></table>`;

        const note = sanitizeHtml(table);
        expect(note).not.toContain("style");
        expect(note).not.toContain("width: 60%");
        expect(note).toContain('data-user-width="60%"');

        const share = sanitizeShareHtml(table);
        expect(share).not.toContain("style");
        expect(share).toContain('data-user-width="60%"');
    });

    it("strips data: href on <a> in both sanitizers", () => {
        const input = `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`;
        for (const out of [sanitizeHtml(input), sanitizeShareHtml(input)]) {
            expect(out).not.toMatch(/data:/i);
            expect(out).not.toMatch(/href\s*=/i);
        }
    });

    it("share sanitizer still allows blob: images and still strips https images", () => {
        const withBlob = `<img src="blob:https://app.example/abc" data-file-id="f1">`;
        expect(sanitizeShareHtml(withBlob)).toContain("blob:");

        const withRemote = `<img src="https://evil.example/px">`;
        const cleaned = sanitizeShareHtml(withRemote);
        expect(cleaned).not.toContain("evil.example");
        expect(cleaned).not.toMatch(/src=["']https?:/i);
    });

    it("strips password inputs; remaining checkboxes are disabled", () => {
        const password = `<label>Password</label><input type="password" name="pw" value="secret">`;
        expect(sanitizeHtml(password)).not.toMatch(/<input/i);
        expect(sanitizeShareHtml(password)).not.toMatch(/<input/i);
        expect(sanitizeHtml(password)).not.toMatch(/type=["']password["']/i);
        expect(sanitizeShareHtml(password)).not.toMatch(/type=["']password["']/i);

        const checkbox = `<input type="checkbox" checked>`;
        const noteBox = sanitizeHtml(checkbox);
        const shareBox = sanitizeShareHtml(checkbox);
        expect(noteBox).toMatch(/type=["']checkbox["']/i);
        expect(shareBox).toMatch(/type=["']checkbox["']/i);
        expect(noteBox).toMatch(/\bdisabled\b/i);
        expect(shareBox).toMatch(/\bdisabled\b/i);
    });

    it("strips inline style from sanitizeHtml (CSS is not parsed)", () => {
        const input = `<div style="background:url(https://evil.com/?c=1)">x</div>`;
        const out = sanitizeHtml(input);
        expect(out).not.toContain("style");
        expect(out).not.toContain("evil.com");
    });

    it("adds rel=noopener noreferrer on target=_blank in sanitizeHtml", () => {
        const blank = `<a href="https://example.com" target="_blank">go</a>`;
        expect(sanitizeHtml(blank)).toContain('rel="noopener noreferrer"');
    });

    // Any other target used to keep whatever rel the content chose (rel="opener", say).
    it("drops any target other than _blank, and the content's own rel with it", () => {
        for (const sanitize of [sanitizeHtml, sanitizeShareHtml]) {
            const out = sanitize(
                `<a href="https://example.com" target="_self" rel="opener">go</a>`,
            );
            expect(out).not.toContain("target");
            expect(out).not.toContain("opener");
            const named = sanitize(
                `<a href="https://example.com" target="win" rel="opener">go</a>`,
            );
            expect(named).not.toContain("target");
        }
    });
});
