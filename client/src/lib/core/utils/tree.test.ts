import { describe, expect, it } from "vitest";
import {
    buildBreadcrumb,
    buildParentPath,
    buildTree,
    collectAncestorIds,
    type FlatItem,
    isDescendantOf,
} from "./tree";

function item(
    id: string,
    parent_id: string | null,
    sort_order: string,
    type = "note",
    title = id,
): FlatItem {
    return { id, parent_id, sort_order, type, title };
}

describe("buildTree", () => {
    it("an empty array returns an empty array", () => {
        expect(buildTree([])).toEqual([]);
    });

    it("a flat list of notes with no parent_id → every one is a root node", () => {
        const items = [item("a", null, "1"), item("b", null, "2"), item("c", null, "3")];
        const tree = buildTree(items);
        expect(tree.map((n) => n.id)).toEqual(["a", "b", "c"]);
        tree.forEach((n) => {
            expect(n.children).toEqual([]);
        });
    });

    it("a note in a folder → folder.children contains the note", () => {
        const items = [item("folder1", null, "1", "folder"), item("note1", "folder1", "2", "note")];
        const tree = buildTree(items);
        expect(tree).toHaveLength(1);
        expect(tree[0]?.id).toBe("folder1");
        expect(tree[0]?.children).toHaveLength(1);
        expect(tree[0]?.children[0]?.id).toBe("note1");
    });

    it("a deep three-level tree — the hierarchy is right", () => {
        const items = [
            item("root", null, "1", "folder"),
            item("sub", "root", "2", "folder"),
            item("leaf", "sub", "3", "note"),
        ];
        const tree = buildTree(items);
        expect(tree[0]?.children[0]?.children[0]?.id).toBe("leaf");
    });

    it("sorts by sort_order within one level", () => {
        const items = [
            item("folder", null, "1", "folder"),
            item("c", "folder", "30"),
            item("a", "folder", "10"),
            item("b", "folder", "20"),
        ];
        const tree = buildTree(items);
        expect(tree[0]?.children.map((n) => n.id)).toEqual(["a", "b", "c"]);
    });

    it("filterFiles=true (the default) — items of type 'file' are filtered out", () => {
        const items = [
            item("folder", null, "1", "folder"),
            item("file1", "folder", "2", "file"),
            item("note1", "folder", "3", "note"),
        ];
        const tree = buildTree(items);
        expect(tree[0]?.children).toHaveLength(1);
        expect(tree[0]?.children[0]?.type).toBe("note");
    });

    it("filterFiles=false — items of type 'file' stay in the tree", () => {
        const items = [item("folder", null, "1", "folder"), item("file1", "folder", "2", "file")];
        const tree = buildTree(items, false);
        expect(tree[0]?.children).toHaveLength(1);
        expect(tree[0]?.children[0]?.type).toBe("file");
    });

    it("a note whose parent does not exist → treated as a root", () => {
        const items = [item("orphan", "nonexistent-parent", "1", "note")];
        const tree = buildTree(items);
        expect(tree).toHaveLength(1);
        expect(tree[0]?.id).toBe("orphan");
    });

    it("root items are sorted by sort_order", () => {
        const items = [item("b", null, "20"), item("a", null, "10"), item("c", null, "30")];
        const tree = buildTree(items);
        expect(tree.map((n) => n.id)).toEqual(["a", "b", "c"]);
    });

    it("a parent cycle still surfaces both folders as roots instead of hiding the subtree", () => {
        const items = [
            item("a", "b", "1", "folder"),
            item("b", "a", "2", "folder"),
            item("note", "a", "3", "note"),
        ];
        const tree = buildTree(items);
        const rootIds = tree.map((n) => n.id).sort();
        expect(rootIds).toEqual(["a", "b"]);
        const a = tree.find((n) => n.id === "a");
        expect(a?.children.map((c) => c.id)).toEqual(["note"]);
    });
});

describe("buildBreadcrumb", () => {
    const items = [
        item("root", null, "1", "folder", "Root"),
        item("sub", "root", "2", "folder", "Sub"),
        item("note", "sub", "3", "note", "Nota"),
    ];

    it("a root item → only its own title", () => {
        expect(buildBreadcrumb("root", items)).toMatchObject([{ id: "root", title: "Root" }]);
    });

    it("a note inside a folder → [Folder, Note]", () => {
        const flat = [
            item("folder", null, "1", "folder", "Folder"),
            item("n", "folder", "2", "note", "Nota"),
        ];
        expect(buildBreadcrumb("n", flat)).toMatchObject([
            { id: "folder", title: "Folder" },
            { id: "n", title: "Nota" },
        ]);
    });

    it("a note three levels deep → [Root, Sub, Note]", () => {
        expect(buildBreadcrumb("note", items)).toMatchObject([
            { id: "root", title: "Root" },
            { id: "sub", title: "Sub" },
            { id: "note", title: "Nota" },
        ]);
    });

    it("an item with no title → 'Untitled' in the trail", () => {
        const flat = [{ id: "x", parent_id: null, sort_order: "1", type: "note" } as FlatItem];
        expect(buildBreadcrumb("x", flat)).toMatchObject([{ id: "x", title: "Untitled" }]);
    });

    it("a non-existent id → an empty array", () => {
        expect(buildBreadcrumb("ne-postoji", items)).toEqual([]);
    });
});

describe("buildParentPath", () => {
    const items = [
        item("root", null, "1", "folder", "Root"),
        item("sub", "root", "2", "folder", "Sub"),
        item("note", "sub", "3", "note", "Nota"),
    ];

    it("a root folder → an empty string", () => {
        expect(buildParentPath("root", items)).toBe("");
    });

    it("a note directly inside a folder → the folder name", () => {
        const flat = [item("folder", null, "1", "folder", "Folder"), item("n", "folder", "2")];
        expect(buildParentPath("n", flat)).toBe("Folder");
    });

    it("a note two levels deep → 'Root / Sub'", () => {
        expect(buildParentPath("note", items)).toBe("Root / Sub");
    });

    it("a root note (no parent) → an empty string", () => {
        const flat = [item("n", null, "1")];
        expect(buildParentPath("n", flat)).toBe("");
    });
});

describe("collectAncestorIds", () => {
    // A → B → C
    const chain = [
        item("A", null, "1", "folder"),
        item("B", "A", "1", "folder"),
        item("C", "B", "1", "folder"),
        item("note", "C", "1"),
    ];

    it("includes the id and its ancestors up to the root", () => {
        expect(collectAncestorIds("C", chain)).toEqual(["C", "B", "A"]);
        expect(collectAncestorIds("B", chain)).toEqual(["B", "A"]);
        expect(collectAncestorIds("A", chain)).toEqual(["A"]);
    });

    it("a non-existent id → an empty chain", () => {
        expect(collectAncestorIds("ghost", chain)).toEqual([]);
    });

    it("cycle-safe", () => {
        const cyc = [item("a", "b", "1", "folder"), item("b", "a", "1", "folder")];
        expect(collectAncestorIds("a", cyc)).toEqual(["a", "b"]);
    });
});

describe("isDescendantOf", () => {
    // f1 → f2 → note ; other (standalone)
    const tree = [
        item("f1", null, "1", "folder"),
        item("f2", "f1", "1", "folder"),
        item("note", "f2", "1"),
        item("other", null, "2"),
    ];

    it("a direct parent and a deeper ancestor", () => {
        expect(isDescendantOf("note", "f2", tree)).toBe(true);
        expect(isDescendantOf("note", "f1", tree)).toBe(true);
    });

    it("not an ancestor (the reverse direction and itself included)", () => {
        expect(isDescendantOf("note", "other", tree)).toBe(false);
        expect(isDescendantOf("f1", "note", tree)).toBe(false);
        expect(isDescendantOf("note", "note", tree)).toBe(false);
    });

    it("a non-existent child → false", () => {
        expect(isDescendantOf("ghost", "f1", tree)).toBe(false);
    });

    it("cycle-safe (it does not hang)", () => {
        const cyc = [item("a", "b", "1"), item("b", "a", "1")];
        expect(isDescendantOf("a", "x", cyc)).toBe(false);
    });
});
