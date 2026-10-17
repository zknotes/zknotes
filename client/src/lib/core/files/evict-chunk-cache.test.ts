// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evictChunkHttpCache } from "./evict-chunk-cache";

describe("evictChunkHttpCache", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("deletes /uploads/ entries but keeps app-shell cache", async () => {
        const uploadsReq = new Request("https://app.test/uploads/cs1/chunks/0");
        const shellReq = new Request("https://app.test/_app/immutable/chunk.js");
        const uploadsDelete = vi.fn().mockResolvedValue(true);
        const shellDelete = vi.fn().mockResolvedValue(true);
        const uploadsCache = {
            keys: vi.fn().mockResolvedValue([uploadsReq]),
            delete: uploadsDelete,
        };
        const shellCache = { keys: vi.fn().mockResolvedValue([shellReq]), delete: shellDelete };

        vi.stubGlobal("caches", {
            keys: vi.fn().mockResolvedValue(["zknotes-chunks", "zknotes-shell-v1"]),
            open: vi.fn(async (name: string) =>
                name === "zknotes-shell-v1" ? shellCache : uploadsCache,
            ),
        });

        await evictChunkHttpCache();

        expect(uploadsDelete).toHaveBeenCalledWith(uploadsReq);
        expect(shellDelete).not.toHaveBeenCalled();
    });
});
