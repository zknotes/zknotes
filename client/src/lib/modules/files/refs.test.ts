import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import {
    countInlineExternalImages,
    extractFileRefs,
    extractFileRefsFromDoc,
    LOCAL_PREFIX,
    mergeAttachmentFileIds,
    reattachEmbedsFromOriginal,
    replaceHugeDataImageTags,
    stripAllFileRefsFromHtml,
} from "./refs";

describe("extractFileRefs", () => {
    it("returns file id from a single encFile reference", () => {
        const html = '<img data-file-id="file-abc" alt="x" />';
        expect(extractFileRefs(html)).toEqual(["file-abc"]);
    });

    it("deduplicates multiple references to the same file", () => {
        const html = ['<span data-file-id="dup-id"></span>', '<img data-file-id="dup-id" />'].join(
            "",
        );
        expect(extractFileRefs(html)).toEqual(["dup-id"]);
    });

    it("returns unique ids for multiple distinct files", () => {
        const html = ['<span data-file-id="a"></span>', '<span data-file-id="b"></span>'].join("");
        expect(extractFileRefs(html)).toEqual(["a", "b"]);
    });

    it("returns empty array for empty or non-string content", () => {
        expect(extractFileRefs("")).toEqual([]);
        expect(extractFileRefs(null)).toEqual([]);
        expect(extractFileRefs(undefined)).toEqual([]);
    });

    it("ignores local: pending upload ids", () => {
        const html = `<span data-file-id="${LOCAL_PREFIX}pending-1"></span>`;
        expect(extractFileRefs(html)).toEqual([]);
    });

    it("ignores malformed attributes without closing quote", () => {
        const html = "<span data-file-id=broken></span>";
        expect(extractFileRefs(html)).toEqual([]);
    });
});

describe("extractFileRefsFromDoc", () => {
    const schema = new Schema({
        nodes: {
            doc: { content: "block+" },
            paragraph: { group: "block", content: "inline*" },
            text: { group: "inline" },
            encFile: {
                group: "block",
                atom: true,
                attrs: { fileId: { default: null } },
            },
        },
    });

    it("collects the real fileIds from the encFile nodes", () => {
        const doc = schema.node("doc", null, [
            schema.node("encFile", { fileId: "f1" }),
            schema.node("paragraph", null, [schema.text("x")]),
            schema.node("encFile", { fileId: "f2" }),
            schema.node("encFile", { fileId: "f1" }),
        ]);
        expect(extractFileRefsFromDoc(doc).sort()).toEqual(["f1", "f2"]);
    });

    it("it skips local: pending ids", () => {
        const doc = schema.node("doc", null, [
            schema.node("encFile", { fileId: `${LOCAL_PREFIX}p1` }),
            schema.node("encFile", { fileId: "real" }),
        ]);
        expect(extractFileRefsFromDoc(doc)).toEqual(["real"]);
    });
});

describe("mergeAttachmentFileIds", () => {
    it("the union of the live and payload refs, with no duplicates", () => {
        expect(
            mergeAttachmentFileIds(["a"], '<img data-file-id="b" /><img data-file-id="a" />'),
        ).toEqual(["a", "b"]);
    });

    it("when the live list is empty, it uses the payload", () => {
        expect(mergeAttachmentFileIds([], '<img data-file-id="x" />')).toEqual(["x"]);
    });
});

describe("countInlineExternalImages", () => {
    it("it detects an img with no data-file-id", () => {
        const html =
            '<p><img src="https://x.test/a.png" /></p><img data-file-id="f1" src="blob:x" />';
        expect(countInlineExternalImages(html)).toBe(1);
    });

    it("counts every inline image (not clamped to 0/1)", () => {
        const html =
            '<img src="https://a.test/1.png" /><img src="https://a.test/2.png" /><img data-file-id="f1" />';
        expect(countInlineExternalImages(html)).toBe(2);
    });

    it("ignores encFile references", () => {
        expect(countInlineExternalImages('<img data-file-id="f1" alt="x" />')).toBe(0);
    });

    it("it does not break on an enormous data: src (a head scan only)", () => {
        const huge = `<img src="data:image/png;base64,${"A".repeat(500_000)}" />`;
        expect(countInlineExternalImages(huge)).toBe(1);
    });
});

describe("stripAllFileRefsFromHtml", () => {
    it("it removes every encFile node and keeps the rest of the text", () => {
        const html =
            '<p>keep</p><img data-file-id="f1" alt="a" /><span data-file-id="f2">x</span><p>end</p>';
        const { html: out, strippedCount } = stripAllFileRefsFromHtml(html);
        expect(strippedCount).toBe(2);
        expect(out).not.toContain("data-file-id");
        expect(out).toContain("keep");
        expect(out).toContain("end");
    });

    it("it returns the original when there are no references", () => {
        const html = "<p>plain</p>";
        expect(stripAllFileRefsFromHtml(html)).toEqual({ html, strippedCount: 0 });
    });
});

describe("reattachEmbedsFromOriginal", () => {
    it("it returns the offline HTML when the original has no embeds", () => {
        expect(reattachEmbedsFromOriginal("<p>offline</p>", "<p>server</p>")).toBe(
            "<p>offline</p>",
        );
    });

    it("it adds the embeds from the original that are missing from the offline content", () => {
        const offline = "<p>offline text</p>";
        const original =
            '<p>server</p><img data-file-id="f1" alt="a" /><img data-file-id="f2" alt="b" />';
        const out = reattachEmbedsFromOriginal(offline, original);
        expect(out).toContain("offline text");
        expect(out).toContain('data-file-id="f1"');
        expect(out).toContain('data-file-id="f2"');
        expect(extractFileRefs(out).sort()).toEqual(["f1", "f2"]);
    });

    it("it does not duplicate embeds already present in the offline HTML", () => {
        const offline = '<p>x</p><img data-file-id="f1" alt="a" />';
        const original =
            '<p>y</p><img data-file-id="f1" alt="a" /><img data-file-id="f2" alt="b" />';
        const out = reattachEmbedsFromOriginal(offline, original);
        expect(extractFileRefs(out).sort()).toEqual(["f1", "f2"]);
        expect(out.match(/data-file-id="f1"/g)?.length).toBe(1);
    });

    it("ignores local: pending ids in the original", () => {
        const out = reattachEmbedsFromOriginal(
            "<p>x</p>",
            `<img data-file-id="${LOCAL_PREFIX}p1" alt="pending" />`,
        );
        expect(out).toBe("<p>x</p>");
    });
});

describe("replaceHugeDataImageTags", () => {
    it("replaces a huge data: img with a placeholder", () => {
        const huge = `<p>x</p><img src="data:image/png;base64,${"A".repeat(100_000)}" alt="pic" />`;
        const out = replaceHugeDataImageTags(huge);
        expect(out).not.toContain("data:image");
        expect(out).toContain("Inline image");
        expect(out).toContain("pic");
        expect(out).toContain("<p>x</p>");
    });

    it("it keeps a small data: img and an encFile", () => {
        const small = '<img src="data:image/png;base64,abc" />';
        expect(replaceHugeDataImageTags(small)).toBe(small);
        const enc = '<img data-file-id="f1" src="blob:x" />';
        expect(replaceHugeDataImageTags(enc)).toBe(enc);
    });
});
