import { describe, expect, it } from "vitest";
import { createsCycle, topoSortByParent } from "./cycle-detection";

describe("Cycle Detection", () => {
    it("should allow moving to a sibling or different branch", () => {
        const parentMap = new Map<string, string | null>([
            ["root", null],
            ["folder1", "root"],
            ["folder2", "root"],
            ["sub1", "folder1"],
        ]);

        // Move sub1 from folder1 to folder2 → valid
        expect(createsCycle("sub1", "folder2", parentMap)).toBe(false);
    });

    it("should detect a direct self-cycle", () => {
        const parentMap = new Map<string, string | null>();
        expect(createsCycle("folder1", "folder1", parentMap)).toBe(true);
    });

    it("should detect a 1-level cycle (parent to child)", () => {
        const parentMap = new Map<string, string | null>([
            ["parent", null],
            ["child", "parent"],
        ]);

        // Move a parent into its child → cycle
        expect(createsCycle("parent", "child", parentMap)).toBe(true);
    });

    it("should detect a deep cycle", () => {
        const parentMap = new Map<string, string | null>([
            ["a", null],
            ["b", "a"],
            ["c", "b"],
            ["d", "c"],
            ["e", "d"],
        ]);

        // Move a into e → cycle
        expect(createsCycle("a", "e", parentMap)).toBe(true);
    });

    it("should pass on a deep chain without cycles", () => {
        const parentMap = new Map<string, string | null>();
        let currentParent = "root";
        parentMap.set(currentParent, null);

        // Build a chain 50 levels deep
        for (let i = 1; i <= 50; i++) {
            const childId = `node_${i}`;
            parentMap.set(childId, currentParent);
            currentParent = childId;
        }

        // Move node_50 to a new root → valid
        expect(createsCycle("node_50", "root", parentMap)).toBe(false);
        // Move node_5 into node_2 → valid
        expect(createsCycle("node_5", "node_2", parentMap)).toBe(false);
        // Move node_2 into node_40 → invalid
        expect(createsCycle("node_2", "node_40", parentMap)).toBe(true);
    });

    it("should handle diamond pattern (multiple paths to same root)", () => {
        // The data model should not technically allow this (parent_id is a string, not an array),
        // but we test moving a node with siblings into a valid sibling — a diamond pattern is
        // impossible in a tree where every node has at most one parent.
        const parentMap = new Map<string, string | null>([
            ["root", null],
            ["left", "root"],
            ["right", "root"],
            ["leaf1", "left"],
            ["leaf2", "right"],
        ]);

        // move right into left → valid
        expect(createsCycle("right", "left", parentMap)).toBe(false);
    });
    it("should return false when moving to root (newParentId is null)", () => {
        const parentMap = new Map<string, string | null>([["child", "parent"]]);
        expect(createsCycle("child", null, parentMap)).toBe(false);
    });

    it("should detect a pre-existing cycle in data", () => {
        const parentMap = new Map<string, string | null>([
            ["a", "b"],
            ["b", "a"],
        ]);
        expect(createsCycle("target", "a", parentMap)).toBe(true);
    });

    it("should abort and return true if depth exceeds maxDepth (function-based source)", () => {
        let counter = 0;
        const parentMapFn = (_id: string) => {
            counter++;
            return `node_${counter}`;
        };
        expect(createsCycle("target", "start", parentMapFn)).toBe(true);
    });

    it("Map chain deeper than 1000 is NOT falsely flagged as a cycle", () => {
        const parentMap = new Map<string, string | null>();
        parentMap.set("root", null);
        let prev = "root";
        for (let i = 1; i <= 5000; i++) {
            const id = `n_${i}`;
            parentMap.set(id, prev);
            prev = id;
        }
        // Move the root beneath the deepest leaf → a real cycle (true).
        expect(createsCycle("root", prev, parentMap)).toBe(true);
        // Move the deepest leaf under "root" → valid (false), even though the chain is > 1000 deep.
        expect(createsCycle(prev, "root", parentMap)).toBe(false);
    });
});

describe("topoSortByParent", () => {
    it("puts a parent before its child when both are in the set", () => {
        const batch = [
            { id: "child", parent_id: "parent" },
            { id: "parent", parent_id: null },
            { id: "other", parent_id: null },
        ];
        const sorted = topoSortByParent(batch, (i) => i.parent_id);
        expect(sorted.map((i) => i.id)).toEqual(["parent", "child", "other"]);
        expect(sorted.findIndex((i) => i.id === "parent")).toBeLessThan(
            sorted.findIndex((i) => i.id === "child"),
        );
    });

    it("does not blow up on a chain 100,000 deep (iterative DFS)", () => {
        const chain: { id: string; parent_id: string | null }[] = [];
        let prev: string | null = null;
        for (let i = 0; i < 100_000; i++) {
            const id = `n_${i}`;
            chain.push({ id, parent_id: prev });
            prev = id;
        }
        chain.reverse();
        const sorted = topoSortByParent(chain, (i) => i.parent_id);
        expect(sorted).toHaveLength(100_000);
        expect(sorted[0]?.id).toBe("n_0");
        expect(sorted[99_999]?.id).toBe("n_99999");
    });

    it("returns every item once when the parents form a cycle, without throwing", () => {
        // A backup taken while a cycle existed: the restore wizard sorts it before staging, and the
        // server's cycle check is what refuses it — the sort must not overflow the stack first.
        const batch = [
            { id: "a", parent_id: "b" },
            { id: "b", parent_id: "a" },
            { id: "c", parent_id: "a" },
        ];
        const sorted = topoSortByParent(batch, (i) => i.parent_id);
        expect(sorted.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
    });
});
