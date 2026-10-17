import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDB } from "$lib/core/db";
import { getPinnedRoots, pinManager } from "$lib/core/files/pin-manager-state.svelte";
import { emitFilesChanged } from "$lib/modules/files/files-changed-bus";
import { buildPinnedItemSet } from "./pin-orchestrator";

// Mock idb (inline fns only — vitest hoists the mock factory before const inits)
vi.mock("$lib/core/db", () => ({
    getDB: vi.fn().mockResolvedValue({ get: vi.fn(), getAll: vi.fn().mockResolvedValue([]) }),
}));

// Mock event bus
vi.mock("$lib/modules/files/files-changed-bus", () => ({
    emitFilesChanged: vi.fn(),
}));

// Mock chunk-loader & download to prevent side effects in tests
vi.mock("$lib/core/files/chunk-loader", () => ({
    evictChunkSet: vi.fn(),
    loadChunk: vi.fn(),
}));

vi.mock("$lib/modules/files/download", () => ({
    getFilePayload: vi.fn(),
}));

const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
        getItem: vi.fn((key) => store[key] || null),
        setItem: vi.fn((key, value) => {
            store[key] = value.toString();
        }),
        clear: vi.fn(() => {
            store = {};
        }),
    };
})();
vi.stubGlobal("localStorage", localStorageMock);
vi.stubGlobal("window", {});

describe("PinManager", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        pinManager.roots = []; // reset state
    });

    it("should set and get pinned roots from local state and localStorage", () => {
        expect(pinManager.isPinned("item-1")).toBe(false);
        pinManager.pinItem("item-1");
        expect(pinManager.isPinned("item-1")).toBe(true);
        expect(getPinnedRoots()).toEqual(["item-1"]);
        expect(JSON.parse(localStorage.getItem("zknotes:pinned-items")!)).toEqual(["item-1"]);
        expect(emitFilesChanged).toHaveBeenCalledWith(["item-1"]);
    });

    it("should unpin item and remove from state", () => {
        const mockDB = {
            getAll: vi.fn().mockResolvedValue([]),
            get: vi.fn().mockResolvedValue(null),
        };
        vi.mocked(getDB).mockResolvedValue(mockDB as any);

        pinManager.pinItem("item-1");
        expect(pinManager.isPinned("item-1")).toBe(true);

        pinManager.unpinItem("item-1");
        expect(pinManager.isPinned("item-1")).toBe(false);
        expect(getPinnedRoots()).toEqual([]);
        expect(emitFilesChanged).toHaveBeenCalledWith(["item-1"]);
    });

    it("should resolve descendants in buildPinnedItemSet", async () => {
        // Real model: folder → note → file (not file.parent = folder).
        const mockDB = {
            getAll: vi.fn().mockResolvedValue([
                { id: "f1", type: "folder", parent_id: null },
                { id: "f2", type: "folder", parent_id: "f1" },
                { id: "note1", type: "note", parent_id: "f2" },
                { id: "file1", type: "file", parent_id: "note1" },
                { id: "note2", type: "note", parent_id: "f1" },
                { id: "file2", type: "file", parent_id: "note2" },
                { id: "file_out", type: "file", parent_id: null },
            ]),
            get: vi.fn().mockResolvedValue(null),
        };
        vi.mocked(getDB).mockResolvedValue(mockDB as any);

        pinManager.pinItem("f1");

        const pinnedSet = await buildPinnedItemSet();

        expect(pinnedSet.has("f1")).toBe(true);
        expect(pinnedSet.has("f2")).toBe(true);
        expect(pinnedSet.has("note1")).toBe(true);
        expect(pinnedSet.has("file1")).toBe(true);
        expect(pinnedSet.has("note2")).toBe(true);
        expect(pinnedSet.has("file2")).toBe(true);
        expect(pinnedSet.has("file_out")).toBe(false);
    });

    it("pin folder covers note→file attachments (not only folder|file map)", async () => {
        const mockDB = {
            getAll: vi.fn().mockResolvedValue([
                { id: "F", type: "folder", parent_id: null },
                { id: "N", type: "note", parent_id: "F" },
                { id: "A", type: "file", parent_id: "N" },
            ]),
            get: vi.fn().mockResolvedValue(null),
        };
        vi.mocked(getDB).mockResolvedValue(mockDB as any);

        pinManager.pinItem("F");
        const pinnedSet = await buildPinnedItemSet();

        expect(pinnedSet.has("F")).toBe(true);
        expect(pinnedSet.has("N")).toBe(true);
        expect(pinnedSet.has("A")).toBe(true);
    });

    it("should handle cycles in folder hierarchy safely", async () => {
        const mockDB = {
            getAll: vi.fn().mockResolvedValue([
                { id: "f1", type: "folder", parent_id: "f2" },
                { id: "f2", type: "folder", parent_id: "f1" },
                { id: "file1", type: "file", parent_id: "f2" },
            ]),
            get: vi.fn().mockResolvedValue(null),
        };
        vi.mocked(getDB).mockResolvedValue(mockDB as any);

        pinManager.pinItem("f1");

        const pinnedSet = await buildPinnedItemSet();

        expect(pinnedSet.has("f1")).toBe(true);
        expect(pinnedSet.has("f2")).toBe(true);
        expect(pinnedSet.has("file1")).toBe(true);
    });
});
