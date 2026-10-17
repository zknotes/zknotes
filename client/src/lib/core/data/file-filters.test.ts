import { describe, expect, it } from "vitest";
import {
    collectNoteIdsInFolder,
    filterFilesByScope,
    matchesFileType,
    parseScopeParam,
    parseTypeParam,
} from "./file-filters";
import type { DecryptedItemMeta } from "./items";

function meta(
    over: Partial<DecryptedItemMeta> & Pick<DecryptedItemMeta, "id" | "type">,
): DecryptedItemMeta {
    return {
        parent_id: null,
        sort_order: over.id,
        title: "T",
        updated_at: 1,
        version: 1,
        ...over,
    } as DecryptedItemMeta;
}

describe("file-filters", () => {
    it("parseScopeParam", () => {
        expect(parseScopeParam(null)).toEqual({ kind: "all" });
        expect(parseScopeParam("note:n1")).toEqual({ kind: "note", id: "n1" });
        expect(parseScopeParam("folder:f1")).toEqual({ kind: "folder", id: "f1" });
    });

    it("parseTypeParam", () => {
        expect(parseTypeParam("images")).toBe("images");
        expect(parseTypeParam("bogus")).toBe("all");
    });

    it("matchesFileType", () => {
        expect(matchesFileType("image/png", "images")).toBe(true);
        expect(matchesFileType("image/png", "docs")).toBe(false);
        expect(matchesFileType("application/pdf", "docs")).toBe(true);
        expect(matchesFileType("audio/mpeg", "audio")).toBe(true);
    });

    it("collectNoteIdsInFolder works recursively", () => {
        const items = [
            { id: "f1", type: "folder", parent_id: null },
            { id: "f2", type: "folder", parent_id: "f1" },
            { id: "n1", type: "note", parent_id: "f1" },
            { id: "n2", type: "note", parent_id: "f2" },
            { id: "n3", type: "note", parent_id: null },
        ];
        expect([...collectNoteIdsInFolder("f1", items)].sort()).toEqual(["n1", "n2"]);
    });

    it("filterFilesByScope note i folder", () => {
        const items = [
            meta({ id: "f1", type: "folder", parent_id: null }),
            meta({ id: "n1", type: "note", parent_id: "f1" }),
            meta({ id: "file-a", type: "file", parent_id: "n1" }),
            meta({ id: "file-b", type: "file", parent_id: null }),
        ];
        const files = items.filter((i) => i.type === "file");
        expect(
            filterFilesByScope(files, { kind: "note", id: "n1" }, items).map((f) => f.id),
        ).toEqual(["file-a"]);
        expect(
            filterFilesByScope(files, { kind: "folder", id: "f1" }, items).map((f) => f.id),
        ).toEqual(["file-a"]);
    });
});
