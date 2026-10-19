import { describe, expect, it } from "vitest";
import { toSearchDoc } from "./doc";
import { UNTITLED } from "./rank";

// Every writer of the search index (sync pull, push result, conflict copies, saves, the rebuild)
// used to build the document by hand, and three of them read `title` for a file — whose display
// name is `name` — so every file was indexed as "Untitled".
describe("toSearchDoc", () => {
    it("a file is indexed under its name, with no content", () => {
        expect(toSearchDoc({ id: "f1", type: "file" }, { name: "report.pdf" })).toEqual({
            id: "f1",
            type: "file",
            title: "report.pdf",
        });
    });

    it("a note contributes its title and the plain text of its content", () => {
        const doc = toSearchDoc(
            { id: "n1", type: "note" },
            { title: "Plan", content: "<p>Hello <b>world</b></p>" },
        );
        expect(doc.title).toBe("Plan");
        expect(doc.content).toContain("Hello world");
    });

    it("a folder never carries content, even when the payload has some", () => {
        expect(
            toSearchDoc({ id: "d1", type: "folder" }, { title: "Work", content: "<p>x</p>" }),
        ).toEqual({ id: "d1", type: "folder", title: "Work" });
    });

    it("without a name or a title the shared placeholder is used, and non-strings are ignored", () => {
        expect(toSearchDoc({ id: "n2", type: "note" }, {}).title).toBe(UNTITLED);
        expect(toSearchDoc({ id: "n3", type: "note" }, { title: 42, content: 7 })).toEqual({
            id: "n3",
            type: "note",
            title: UNTITLED,
        });
    });
});
