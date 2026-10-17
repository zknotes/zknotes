import { describe, expect, it, vi } from "vitest";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import { filterLinkableNotes, insertNoteMention } from "./note-mentions";

function note(id: string, title: string): DecryptedItemMeta {
    return {
        id,
        type: "note",
        title,
        parent_id: null,
        sort_order: "a",
        version: 1,
        updated_at: 0,
    };
}

describe("filterLinkableNotes", () => {
    const items = [
        note("a", "Alpha"),
        note("b", "Beta note"),
        note("c", "Gamma"),
        { ...note("f1", "file"), type: "file" as const },
    ];

    it("excludes current note and non-notes", () => {
        const result = filterLinkableNotes(items, "a", "");
        expect(result.map((n) => n.id)).toEqual(["b", "c"]);
    });

    it("filters by query case-insensitively", () => {
        const result = filterLinkableNotes(items, "a", "BETA");
        expect(result.map((n) => n.id)).toEqual(["b"]);
    });

    it("respects limit", () => {
        const result = filterLinkableNotes(items, undefined, "", 1);
        expect(result).toHaveLength(1);
    });
});

describe("insertNoteMention", () => {
    it("inserts mention node at cursor", () => {
        const run = vi.fn();
        const chain = {
            focus: vi.fn().mockReturnThis(),
            deleteSelection: vi.fn().mockReturnThis(),
            insertContent: vi.fn().mockReturnThis(),
            run,
        };
        const editor = {
            chain: vi.fn(() => chain),
        } as unknown as import("@tiptap/core").Editor;

        insertNoteMention(editor, { id: "b", label: "Beta" });

        expect(chain.insertContent).toHaveBeenCalledWith({
            type: "mention",
            attrs: { id: "b", label: "Beta" },
        });
        expect(run).toHaveBeenCalled();
    });
});
