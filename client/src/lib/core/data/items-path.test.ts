import { describe, expect, it } from "vitest";
import { folderPathLabel, folderPathSegments } from "./items";

// Saas spec 156 (package G): "where an item lives" — root first, a missing ancestor marked, cycles end.
describe("folderPathSegments", () => {
    const byId = new Map([
        ["a", { title: "A", parent_id: null }],
        ["b", { title: "", parent_id: "a", deleted: true }],
        ["c", { title: "C", parent_id: "b" }],
    ]);

    it("walks from the root down, excluding the item itself, with the trash flag per ancestor", () => {
        expect(folderPathSegments(null, byId)).toEqual([]);
        expect(folderPathSegments("c", byId)).toEqual([
            { id: "a", title: "A", deleted: false },
            { id: "b", title: "Untitled", deleted: true },
            { id: "c", title: "C", deleted: false },
        ]);
    });

    it("a parent missing from the map ends the path with one Unknown segment", () => {
        expect(folderPathSegments("ghost", byId)).toEqual([
            { id: "ghost", title: "Unknown", deleted: true },
        ]);
    });

    it("a cycle terminates", () => {
        const loop = new Map([
            ["p", { title: "P", parent_id: "q" }],
            ["q", { title: "Q", parent_id: "p" }],
        ]);
        expect(folderPathSegments("p", loop).map((s) => s.id)).toEqual(["q", "p"]);
    });
});

describe("folderPathLabel", () => {
    const byId = new Map([
        ["a", { title: "A", parent_id: null }],
        ["b", { title: "B", parent_id: "a" }],
    ]);
    it("joins the segments, or names the root", () => {
        expect(folderPathLabel(null, byId)).toBe("Home");
        expect(folderPathLabel(null, byId, "Root")).toBe("Root");
        expect(folderPathLabel("b", byId)).toBe("A / B");
        expect(folderPathLabel("ghost", byId)).toBe("Unknown");
    });
});
