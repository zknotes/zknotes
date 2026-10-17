import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { changedBlockRanges, topBlockTexts } from "./sync-highlight";

/** A minimal schema: doc > block+ , block = a paragraph with text. */
const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: {
            group: "block",
            content: "text*",
            parseDOM: [{ tag: "p" }],
            toDOM: () => ["p", 0],
        },
        text: { group: "inline" },
    },
});

function docFromParagraphs(...texts: string[]) {
    const paragraphs = texts.map((t) => schema.node("paragraph", null, t ? [schema.text(t)] : []));
    return schema.node("doc", null, paragraphs);
}

describe("topBlockTexts", () => {
    it("returns the textContent of every top-level block", () => {
        const doc = docFromParagraphs("alpha", "beta", "");
        expect(topBlockTexts(doc)).toEqual(["alpha", "beta", ""]);
    });
});

describe("changedBlockRanges", () => {
    it("marks a block appended at the end", () => {
        const before = ["a", "b"];
        const doc = docFromParagraphs("a", "b", "c");
        const ranges = changedBlockRanges(doc, before);
        expect(ranges).toHaveLength(1);
        // the third paragraph
        expect(doc.textBetween(ranges[0]![0], ranges[0]![1])).toBe("c");
    });

    it("marks a changed block in the middle", () => {
        const before = ["a", "b", "c"];
        const doc = docFromParagraphs("a", "B!", "c");
        const ranges = changedBlockRanges(doc, before);
        expect(ranges).toHaveLength(1);
        expect(doc.textBetween(ranges[0]![0], ranges[0]![1])).toBe("B!");
    });

    it("multiset: consumes one instance of duplicated text", () => {
        // before has two "x"; after has three "x" → one new one
        const before = ["x", "x"];
        const doc = docFromParagraphs("x", "x", "x");
        const ranges = changedBlockRanges(doc, before);
        expect(ranges).toHaveLength(1);
    });

    it("does not highlight empty blocks", () => {
        const before = ["a"];
        const doc = docFromParagraphs("a", "");
        expect(changedBlockRanges(doc, before)).toEqual([]);
    });

    it("a reorder without a content change highlights nothing (the point of the multiset diff)", () => {
        const before = ["a", "b"];
        const doc = docFromParagraphs("b", "a");
        expect(changedBlockRanges(doc, before)).toEqual([]);
    });
});
