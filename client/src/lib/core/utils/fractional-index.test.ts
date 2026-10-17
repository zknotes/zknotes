import { describe, expect, it } from "vitest";
import { calcDropSortOrder, calcInsertSortOrder, getMidString } from "./fractional-index";

describe("getMidString", () => {
    it("(null, null) returns a non-empty string", () => {
        const result = getMidString(null, null);
        expect(result.length).toBeGreaterThan(0);
    });

    it("(null, 'b') returns a string smaller than 'b'", () => {
        const result = getMidString(null, "b");
        expect(result < "b").toBe(true);
    });

    it("('a', null) returns a string larger than 'a'", () => {
        const result = getMidString("a", null);
        expect(result > "a").toBe(true);
    });

    it("('a', 'c') returns a string between 'a' and 'c'", () => {
        const result = getMidString("a", "c");
        expect(result > "a").toBe(true);
        expect(result < "c").toBe(true);
    });

    it("('a', 'b') — adjacent characters, the extend fallback", () => {
        const result = getMidString("a", "b");
        expect(result > "a").toBe(true);
        expect(result < "b").toBe(true);
    });

    it("('m', 'n') — adjacent ASCII characters", () => {
        const result = getMidString("m", "n");
        expect(result > "m").toBe(true);
        expect(result < "n").toBe(true);
    });

    it("('aaaa', 'aaab') — a shared prefix with adjacent final characters", () => {
        const result = getMidString("aaaa", "aaab");
        expect(result > "aaaa").toBe(true);
        expect(result < "aaab").toBe(true);
    });

    it("a sequential append grows strictly across 20 iterations", () => {
        let prev = getMidString(null, null);
        for (let i = 0; i < 20; i++) {
            const next = getMidString(prev, null);
            expect(next > prev).toBe(true);
            prev = next;
        }
    });

    it("a sequential prepend falls strictly across 20 iterations", () => {
        let next = getMidString(null, null);
        for (let i = 0; i < 20; i++) {
            const prev = getMidString(null, next);
            expect(prev < next).toBe(true);
            next = prev;
        }
    });

    it("three generated values sort correctly", () => {
        const a = getMidString(null, null);
        const b = getMidString(a, null);
        const c = getMidString(b, null);
        const sorted = [c, a, b].sort();
        expect(sorted).toEqual([a, b, c]);
    });

    it("inserting between two elements preserves the order", () => {
        const first = "a";
        const last = "z";
        const mid = getMidString(first, last);
        expect(mid > first).toBe(true);
        expect(mid < last).toBe(true);

        const midLeft = getMidString(first, mid);
        expect(midLeft > first).toBe(true);
        expect(midLeft < mid).toBe(true);

        const midRight = getMidString(mid, last);
        expect(midRight > mid).toBe(true);
        expect(midRight < last).toBe(true);
    });
});

type Item = { id: string; parent_id: string | null; sort_order: string; type: string };

function note(id: string, parent_id: string | null, sort_order: string): Item {
    return { id, parent_id, sort_order, type: "note" };
}

function folder(id: string, parent_id: string | null, sort_order: string): Item {
    return { id, parent_id, sort_order, type: "folder" };
}

describe("calcInsertSortOrder", () => {
    it("with no refItem → { parentId: null, sortOrder: undefined }", () => {
        expect(calcInsertSortOrder(undefined, [])).toEqual({
            parentId: null,
            sortOrder: undefined,
        });
    });

    it("refItem is a folder with no children → sortOrder is undefined", () => {
        const f = folder("f1", null, "10");
        const result = calcInsertSortOrder(f, [f]);
        expect(result.parentId).toBe("f1");
        expect(result.sortOrder).toBeUndefined();
    });

    it("refItem is a folder with children → sortOrder is lower than the first child's", () => {
        const f = folder("f1", null, "10");
        const child = note("n1", "f1", "50");
        const result = calcInsertSortOrder(f, [f, child]);
        expect(result.parentId).toBe("f1");
        // sortOrder = "0" + child.sort_order = "050", which is < "50"
        expect(result.sortOrder! < child.sort_order).toBe(true);
    });

    it("refItem is a note → parentId = note.parent_id; sortOrder > note.sort_order", () => {
        const n = note("n1", "folder1", "20");
        const result = calcInsertSortOrder(n, [n]);
        expect(result.parentId).toBe("folder1");
        expect(result.sortOrder! > "20").toBe(true);
    });

    it("the refItem is a note with an existing successor → sortOrder stays strictly between them", () => {
        const n1 = note("n1", "folder1", "20");
        const n2 = note("n2", "folder1", "40");
        const result = calcInsertSortOrder(n1, [n1, n2]);
        expect(result.sortOrder! > "20").toBe(true);
        expect(result.sortOrder! < "40").toBe(true);
    });

    // Regression: "New note" in the UI sets the note just created as the next
    // reference (activeSidebarId.set), so successive clicks call this recursively with
    // the item just created as refItem. The old `${sort_order}a${Date.now()}` pattern added ~14
    // characters PER CALL — 20 clicks = 36 (uuidv7) + 20×14 = 316 characters, above Zod's
    // `sort_order.max(256)` (shared/src/schemas.ts) → the whole push batch refused with a 400.
    it("20 consecutive inserts next to the newest item keep sort_order short", () => {
        const items: Item[] = [note("seed", "folder1", "0".repeat(36))];
        let ref = items[0]!;
        for (let i = 0; i < 20; i++) {
            const result = calcInsertSortOrder(ref, items);
            expect(result.sortOrder).toBeDefined();
            const created = note(`n${i}`, result.parentId, result.sortOrder!);
            items.push(created);
            ref = created; // UI: activeSidebarId.set(item.id) after every createItem call
        }
        for (const item of items) {
            expect(item.sort_order.length).toBeLessThan(100);
        }
        // The order has to stay consistent (each one strictly larger than the last).
        const sorted = [...items].sort((a, b) => (a.sort_order < b.sort_order ? -1 : 1));
        expect(sorted.map((i) => i.id)).toEqual(items.map((i) => i.id));
    });
});

describe("calcDropSortOrder", () => {
    describe('pos="inside"', () => {
        it("a folder with no children → newParentId = folder.id, and newSortOrder is a non-empty string", () => {
            const f = folder("f1", null, "10");
            const result = calcDropSortOrder("inside", f, [f]);
            expect(result.newParentId).toBe("f1");
            expect(result.newSortOrder.length).toBeGreaterThan(0);
        });

        it("a folder with children → newSortOrder < the first child's sort_order", () => {
            const f = folder("f1", null, "10");
            const child = note("n1", "f1", "50");
            const result = calcDropSortOrder("inside", f, [f, child]);
            expect(result.newParentId).toBe("f1");
            expect(result.newSortOrder < child.sort_order).toBe(true);
        });
    });

    describe('pos="top"', () => {
        it("the first entry in the list (there is nothing before it) → newSortOrder < target.sort_order", () => {
            const siblings = [note("n1", "p", "10"), note("n2", "p", "20")];
            const result = calcDropSortOrder("top", siblings[0]!, siblings);
            expect(result.newParentId).toBe("p");
            expect(result.newSortOrder < siblings[0]?.sort_order).toBe(true);
        });

        it("between two elements → prev < newSortOrder < target", () => {
            const siblings = [note("n1", "p", "10"), note("n2", "p", "20"), note("n3", "p", "30")];
            const result = calcDropSortOrder("top", siblings[1]!, siblings);
            expect(result.newSortOrder > siblings[0]?.sort_order).toBe(true);
            expect(result.newSortOrder < siblings[1]?.sort_order).toBe(true);
        });
    });

    describe('pos="bottom"', () => {
        it("the last item in the list, with no successor → newSortOrder > target.sort_order", () => {
            const siblings = [note("n1", "p", "10"), note("n2", "p", "20")];
            const result = calcDropSortOrder("bottom", siblings[1]!, siblings);
            expect(result.newParentId).toBe("p");
            expect(result.newSortOrder > siblings[1]?.sort_order).toBe(true);
        });

        it("between two elements → target < newSortOrder < next", () => {
            const siblings = [note("n1", "p", "10"), note("n2", "p", "20"), note("n3", "p", "30")];
            const result = calcDropSortOrder("bottom", siblings[1]!, siblings);
            expect(result.newSortOrder > siblings[1]?.sort_order).toBe(true);
            expect(result.newSortOrder < siblings[2]?.sort_order).toBe(true);
        });
    });

    it("newParentId follows the target's parent_id for top/bottom", () => {
        const siblings = [note("n1", "parent-xyz", "10")];
        const result = calcDropSortOrder("bottom", siblings[0]!, siblings);
        expect(result.newParentId).toBe("parent-xyz");
    });
});
