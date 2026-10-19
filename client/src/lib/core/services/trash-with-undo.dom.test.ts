import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$app/navigation", () => ({ goto: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/core/services/item-service", () => ({
    ItemService: {
        deleteItem: vi.fn().mockResolvedValue(undefined),
        restoreItem: vi.fn().mockResolvedValue(undefined),
    },
}));

const { goto } = await import("$app/navigation");
const { ItemService } = await import("$lib/core/services/item-service");
const { activeSidebarId } = await import("$lib/core/stores/active-sidebar-id.svelte");
const { globalToasts } = await import("$lib/core/stores/toast.svelte");
const { trashNodeWithUndo } = await import("./trash-with-undo");

// The sidebar: folder F holding note A, then note B at the root.
const TREE = [
    { id: "f", parent_id: null },
    { id: "a", parent_id: "f" },
    { id: "b", parent_id: null },
];

function renderRows() {
    document.body.innerHTML = [
        ["f", "folder"],
        ["a", "note"],
        ["b", "note"],
    ]
        .map(
            ([id, type]) =>
                `<div class="tree-item-row" tabindex="0" data-node-id="${id}" data-node-type="${type}"></div>`,
        )
        .join("");
}

beforeEach(() => {
    renderRows();
    activeSidebarId.set(null);
    globalToasts.toasts = [];
    vi.mocked(goto).mockClear();
    vi.mocked(ItemService.deleteItem).mockClear();
    vi.mocked(ItemService.restoreItem).mockClear();
});

afterEach(() => {
    document.body.innerHTML = "";
});

describe("trashNodeWithUndo", () => {
    it("trashing a folder leaves the editor when the open note is inside it", async () => {
        const onItemsChanged = vi.fn();
        await trashNodeWithUndo({
            id: "f",
            type: "folder",
            title: "Work",
            openNoteId: "a",
            treeItems: TREE,
            onItemsChanged,
        });

        expect(ItemService.deleteItem).toHaveBeenCalledWith("f");
        expect(onItemsChanged).toHaveBeenCalledTimes(1);
        // No row above the first folder → nothing to focus, and the editor goes home.
        expect(goto).toHaveBeenCalledWith("/", { keepFocus: true });
        expect(activeSidebarId.current).toBeNull();
        expect(globalToasts.toasts.at(-1)?.message).toBe("Work moved to trash");
    });

    it("trashing the open note itself moves the editor to the row that takes its place", async () => {
        await trashNodeWithUndo({
            id: "a",
            type: "note",
            title: "A",
            openNoteId: "a",
            treeItems: TREE,
            onItemsChanged: () => {},
        });

        expect(goto).toHaveBeenCalledWith("/note/b", { keepFocus: true });
        expect(activeSidebarId.current).toBe("b");
        expect(document.activeElement?.getAttribute("data-node-id")).toBe("b");
    });

    it("trashing another note leaves the editor alone and focuses the neighbour", async () => {
        await trashNodeWithUndo({
            id: "b",
            type: "note",
            title: "B",
            openNoteId: "a",
            treeItems: TREE,
            onItemsChanged: () => {},
        });

        expect(goto).not.toHaveBeenCalled();
        // The last row goes, so the one above it takes the focus.
        expect(activeSidebarId.current).toBe("a");
    });

    it("Undo restores the item and refreshes the lists again", async () => {
        const onItemsChanged = vi.fn();
        await trashNodeWithUndo({
            id: "b",
            type: "note",
            title: undefined,
            openNoteId: undefined,
            treeItems: TREE,
            onItemsChanged,
        });

        const toast = globalToasts.toasts.at(-1);
        expect(toast?.message).toBe("Item moved to trash");
        await toast?.action?.onClick();
        expect(ItemService.restoreItem).toHaveBeenCalledWith("b");
        expect(onItemsChanged).toHaveBeenCalledTimes(2);
    });
});
