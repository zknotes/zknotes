import { describe, expect, it } from "vitest";
import { collectDescendants } from "./tree";

// Saas spec 156 (package G): the one traversal behind cascade delete, restore and purge.
const n = (id: string, parent_id: string | null, deleted = false) => ({ id, parent_id, deleted });

describe("collectDescendants", () => {
    const items = [n("root", null), n("a", "root"), n("b", "a", true), n("c", "b"), n("x", null)];

    it("takes the whole subtree below the seeds, seeds included", () => {
        expect([...collectDescendants(items, ["a"])].sort()).toEqual(["a", "b", "c"]);
    });

    it("the predicate prunes a branch: a non-matching node stops the descent below it", () => {
        expect([...collectDescendants(items, ["a"], (it) => it.deleted)].sort()).toEqual([
            "a",
            "b",
        ]);
    });

    it("seeds stay even when the predicate rejects them, and a cycle terminates", () => {
        expect([...collectDescendants(items, ["x"], () => false)]).toEqual(["x"]);
        const cyclic = [n("p", "q"), n("q", "p")];
        expect([...collectDescendants(cyclic, ["p"])].sort()).toEqual(["p", "q"]);
    });
});
