import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDB } from "$lib/core/db";
import { deleteChunkSet, listChunkSetsByAge } from "$lib/core/db/file-chunks";
import { emitFilesChanged } from "$lib/modules/files/files-changed-bus";
import { buildPinnedItemSet } from "./pin-orchestrator";
import { clearUnpinnedCache } from "./storage-manager";

vi.mock("$lib/core/db", () => ({
    getDB: vi.fn(),
}));

vi.mock("./pin-orchestrator", () => ({
    buildPinnedItemSet: vi.fn(),
}));

vi.mock("$lib/core/db/file-chunks", () => ({
    deleteChunkSet: vi.fn(),
    listChunkSetsByAge: vi.fn(),
}));

vi.mock("$lib/modules/files/files-changed-bus", () => ({
    emitFilesChanged: vi.fn(),
}));

describe("storage-manager", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should clear unpinned files and return freed bytes", async () => {
        const mockDB = {
            getAll: vi.fn().mockResolvedValue([
                { id: "pinned-item", type: "file", chunk_set_id: "pinned-set" },
                { id: "unpinned-item-1", type: "file", chunk_set_id: "unpinned-set-1" },
                { id: "unpinned-item-2", type: "file", chunk_set_id: "unpinned-set-2" },
            ]),
        };
        vi.mocked(getDB).mockResolvedValue(mockDB as any);

        const pinnedSet = new Set(["pinned-item"]);
        vi.mocked(buildPinnedItemSet).mockResolvedValue(pinnedSet);

        vi.mocked(listChunkSetsByAge).mockResolvedValue([
            { chunkSetId: "pinned-set", bytes: 100, oldestStoredAt: 1 },
            { chunkSetId: "unpinned-set-1", bytes: 200, oldestStoredAt: 2 },
            { chunkSetId: "unpinned-set-2", bytes: 300, oldestStoredAt: 3 },
        ]);

        vi.mocked(deleteChunkSet)
            .mockResolvedValueOnce(200) // for unpinned-set-1
            .mockResolvedValueOnce(300); // for unpinned-set-2

        const freedBytes = await clearUnpinnedCache();

        expect(freedBytes).toBe(500);
        expect(deleteChunkSet).toHaveBeenCalledTimes(2);
        expect(deleteChunkSet).toHaveBeenCalledWith("unpinned-set-1");
        expect(deleteChunkSet).toHaveBeenCalledWith("unpinned-set-2");
        expect(deleteChunkSet).not.toHaveBeenCalledWith("pinned-set");
        expect(emitFilesChanged).toHaveBeenCalledWith(["unpinned-item-1", "unpinned-item-2"]);
    });

    it("should do nothing if no unpinned files", async () => {
        const mockDB = {
            getAll: vi
                .fn()
                .mockResolvedValue([
                    { id: "pinned-item", type: "file", chunk_set_id: "pinned-set" },
                ]),
        };
        vi.mocked(getDB).mockResolvedValue(mockDB as any);

        const pinnedSet = new Set(["pinned-item"]);
        vi.mocked(buildPinnedItemSet).mockResolvedValue(pinnedSet);

        vi.mocked(listChunkSetsByAge).mockResolvedValue([
            { chunkSetId: "pinned-set", bytes: 100, oldestStoredAt: 1 },
        ]);

        const freedBytes = await clearUnpinnedCache();

        expect(freedBytes).toBe(0);
        expect(deleteChunkSet).not.toHaveBeenCalled();
        expect(emitFilesChanged).not.toHaveBeenCalled();
    });
});
