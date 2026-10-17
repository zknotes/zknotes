// Unit tests for the presence helper (selective sync).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();
const mockHasAllChunks = vi.fn();

vi.mock("$lib/core/db", () => ({
    getDB: vi.fn().mockResolvedValue({ get: mockGet }),
}));
vi.mock("$lib/core/db/file-chunks", () => ({
    hasAllChunks: mockHasAllChunks,
}));

// A dynamic import AFTER the mocks, so the module cache picks up the mocked versions
const { checkFilePresence } = await import("./presence");

describe("checkFilePresence", () => {
    beforeEach(() => {
        mockGet.mockReset();
        mockHasAllChunks.mockReset();
    });

    it("returns 'cloud' when the item has no chunk_set_id", async () => {
        mockGet.mockResolvedValue({ id: "f1", type: "file" });
        expect(await checkFilePresence("f1")).toBe("cloud");
        expect(mockHasAllChunks).not.toHaveBeenCalled();
    });

    it("returns 'cloud' when the item has no chunk_count", async () => {
        mockGet.mockResolvedValue({ id: "f1", type: "file", chunk_set_id: "set-1" });
        expect(await checkFilePresence("f1")).toBe("cloud");
        expect(mockHasAllChunks).not.toHaveBeenCalled();
    });

    it("returns 'cloud' when the item does not exist", async () => {
        mockGet.mockResolvedValue(undefined);
        expect(await checkFilePresence("missing")).toBe("cloud");
        expect(mockHasAllChunks).not.toHaveBeenCalled();
    });

    it("returns 'cloud' when hasAllChunks returns false (an incomplete cache)", async () => {
        mockGet.mockResolvedValue({
            id: "f1",
            type: "file",
            chunk_set_id: "set-1",
            chunk_count: 3,
        });
        mockHasAllChunks.mockResolvedValue(false);
        expect(await checkFilePresence("f1")).toBe("cloud");
        expect(mockHasAllChunks).toHaveBeenCalledWith("set-1", 3);
    });

    it("returns 'downloaded' when hasAllChunks returns true (every chunk is local)", async () => {
        mockGet.mockResolvedValue({
            id: "f1",
            type: "file",
            chunk_set_id: "set-1",
            chunk_count: 3,
        });
        mockHasAllChunks.mockResolvedValue(true);
        expect(await checkFilePresence("f1")).toBe("downloaded");
        expect(mockHasAllChunks).toHaveBeenCalledWith("set-1", 3);
    });
});
