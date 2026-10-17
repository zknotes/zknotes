import { describe, expect, it } from "vitest";
import { buildItemPath, type PathMeta, safeName } from "./utils";

describe("safeName", () => {
    it("never yields . or .., which would climb out of a ZIP", () => {
        expect(safeName("..")).toBe("_");
        expect(safeName(" . ")).toBe("_");
        expect(safeName("...")).toBe("...");
    });

    it("replaces invalid filesystem characters", () => {
        expect(safeName("bad/name\\with*chars?")).toBe("bad_name_with_chars_");
    });

    it("normalizes whitespace and trims", () => {
        expect(safeName("  hello   world  ")).toBe("hello world");
    });

    it("returns Untitled for whitespace-only input", () => {
        expect(safeName("   ")).toBe("Untitled");
    });
});

describe("buildItemPath", () => {
    function meta(
        id: string,
        parent_id: string | null,
        title: string,
        type: string = "folder",
    ): [string, PathMeta] {
        return [id, { parent_id, title, type }];
    }

    it("builds ancestor folder path without the item name", () => {
        const byId = new Map([meta("root", null, "Root"), meta("child", "root", "Child", "note")]);
        expect(buildItemPath("child", byId)).toBe("Root");
    });

    it("returns empty prefix for root-level items", () => {
        const byId = new Map([meta("root", null, "Root", "note")]);
        expect(buildItemPath("root", byId)).toBe("");
    });

    it("stops when parent is not a folder", () => {
        const byId = new Map([
            meta("folder", null, "Folder"),
            meta("note", "folder", "Note Title", "note"),
            meta("file", "note", "file.bin", "file"),
        ]);
        expect(buildItemPath("file", byId)).toBe("");
    });

    it("is cycle-safe and does not loop on cyclic parents", () => {
        const byId = new Map([
            meta("a", "b", "A"),
            meta("b", "a", "B"),
            meta("note", "a", "Note", "note"),
        ]);
        expect(buildItemPath("note", byId)).toBe("B/A");
    });
});
