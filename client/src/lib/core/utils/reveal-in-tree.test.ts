import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pendingExpandId } from "$lib/core/stores/pending-expand.svelte";
import { expandedFolders } from "./expanded-folders";
import { revealFolderInTree } from "./reveal-in-tree";

function makeLocalStorage() {
    let store: Record<string, string> = {};
    return {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
            store[key] = value;
        },
        removeItem: (key: string) => {
            delete store[key];
        },
        clear: () => {
            store = {};
        },
    };
}

beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    pendingExpandId.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    pendingExpandId.clear();
});

describe("revealFolderInTree", () => {
    const items = [
        { id: "A", parent_id: null },
        { id: "B", parent_id: "A" },
        { id: "C", parent_id: "B" },
    ];

    it("expands the whole A/B/C path in localStorage and pendingExpand", () => {
        revealFolderInTree("C", items);

        expect(expandedFolders.isExpanded("A")).toBe(true);
        expect(expandedFolders.isExpanded("B")).toBe(true);
        expect(expandedFolders.isExpanded("C")).toBe(true);
        expect(pendingExpandId.has("A")).toBe(true);
        expect(pendingExpandId.has("B")).toBe(true);
        expect(pendingExpandId.has("C")).toBe(true);
    });

    it("a non-existent folder leaves the state alone", () => {
        revealFolderInTree("ghost", items);
        expect(pendingExpandId.has("ghost")).toBe(false);
        expect(expandedFolders.isExpanded("A")).toBe(false);
    });

    it("consume takes the id off the queue", () => {
        revealFolderInTree("B", items);
        expect(pendingExpandId.consume("B")).toBe(true);
        expect(pendingExpandId.has("B")).toBe(false);
        expect(pendingExpandId.has("A")).toBe(true);
    });
});
