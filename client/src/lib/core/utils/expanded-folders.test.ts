import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expandedFolders } from "./expanded-folders";

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
        get length() {
            return Object.keys(store).length;
        },
        key: (i: number) => Object.keys(store)[i] ?? null,
        _dump: () => store,
    };
}

let ls = makeLocalStorage();

beforeEach(() => {
    ls = makeLocalStorage();
    vi.stubGlobal("localStorage", ls);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("expandedFolders", () => {
    it("uses f_<id> keys with value 1 when expanded", () => {
        expandedFolders.expand("folder-abc");

        expect(ls.getItem("f_folder-abc")).toBe("1");
        expect(expandedFolders.isExpanded("folder-abc")).toBe(true);
    });

    it("collapse removes the storage key", () => {
        expandedFolders.expand("folder-abc");
        expandedFolders.collapse("folder-abc");

        expect(ls.getItem("f_folder-abc")).toBeNull();
        expect(expandedFolders.isExpanded("folder-abc")).toBe(false);
    });

    it("set toggles expand/collapse", () => {
        expandedFolders.set("folder-x", true);
        expect(expandedFolders.isExpanded("folder-x")).toBe(true);

        expandedFolders.set("folder-x", false);
        expect(expandedFolders.isExpanded("folder-x")).toBe(false);
    });

    it("clearAll removes f_* keys and leaves others", () => {
        expandedFolders.expand("a");
        ls.setItem("theme", "dark");
        expandedFolders.clearAll();
        expect(ls.getItem("f_a")).toBeNull();
        expect(ls.getItem("theme")).toBe("dark");
    });
});
