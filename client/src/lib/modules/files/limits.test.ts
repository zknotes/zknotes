import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getStorageMock = vi.hoisted(() => vi.fn());

vi.mock("$lib/core/api", () => ({
    getStorage: getStorageMock,
}));

async function loadLimits() {
    return await import("./limits");
}

describe("file limits", () => {
    beforeEach(() => {
        vi.resetModules();
        getStorageMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reports 0 as the cap until GET /me/storage returns a limit", async () => {
        const { getMaxFileSize, getMaxFileSizeMB } = await loadLimits();

        expect(getMaxFileSize()).toBe(0);
        expect(getMaxFileSizeMB()).toBe(0);
        expect(getStorageMock).not.toHaveBeenCalled();
    });

    it("refreshFileLimits updates cached limit from GET /me/storage", async () => {
        getStorageMock.mockResolvedValueOnce({ max_file_size: 25 * 1024 * 1024 });
        const { getMaxFileSize, getMaxFileSizeMB, refreshFileLimits } = await loadLimits();

        await refreshFileLimits();

        expect(getMaxFileSize()).toBe(25 * 1024 * 1024);
        expect(getMaxFileSizeMB()).toBe(25);
    });

    it("refreshFileLimits keeps previous value on API error", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        getStorageMock.mockResolvedValueOnce({ max_file_size: 10 * 1024 * 1024 });
        const { getMaxFileSize, refreshFileLimits } = await loadLimits();
        await refreshFileLimits();
        getStorageMock.mockRejectedValueOnce(new Error("offline"));

        await refreshFileLimits();

        expect(getMaxFileSize()).toBe(10 * 1024 * 1024);
    });

    it("stays unknown when the first fetch fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        getStorageMock.mockRejectedValueOnce(new Error("offline"));
        const { getMaxFileSize, isMaxFileSizeKnown, refreshFileLimits } = await loadLimits();

        await refreshFileLimits();

        expect(getMaxFileSize()).toBe(0);
        expect(isMaxFileSizeKnown()).toBe(false);
    });

    it("ignores invalid max_file_size values", async () => {
        getStorageMock.mockResolvedValueOnce({ max_file_size: 10 * 1024 * 1024 });
        const { getMaxFileSize, refreshFileLimits } = await loadLimits();
        await refreshFileLimits();
        getStorageMock.mockResolvedValueOnce({ max_file_size: -1 });

        await refreshFileLimits();

        expect(getMaxFileSize()).toBe(10 * 1024 * 1024);
    });

    it("ignores unauthorized responses without adopting a compile-time default", async () => {
        getStorageMock.mockRejectedValueOnce(new Error("unauthorized"));
        const { getMaxFileSize, refreshFileLimits } = await loadLimits();

        await refreshFileLimits();

        expect(getMaxFileSize()).toBe(0);
    });

    // An unknown limit is not a limit of 0 — nothing is refused until the server has said.
    it("tells an unknown limit apart from a known one", async () => {
        getStorageMock.mockResolvedValueOnce({ max_file_size: 10 * 1024 * 1024 });
        const { exceedsKnownFileSizeLimit, isMaxFileSizeKnown, refreshFileLimits } =
            await loadLimits();

        expect(isMaxFileSizeKnown()).toBe(false);
        expect(exceedsKnownFileSizeLimit(20 * 1024 * 1024)).toBe(false);

        await refreshFileLimits();

        expect(isMaxFileSizeKnown()).toBe(true);
        expect(exceedsKnownFileSizeLimit(20 * 1024 * 1024)).toBe(true);
        expect(exceedsKnownFileSizeLimit(10 * 1024 * 1024)).toBe(false);
    });

    it("isOverFileSizeLimit refuses nothing while the server cannot say, and asks it first", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        getStorageMock.mockRejectedValue(new TypeError("Failed to fetch"));
        const { isOverFileSizeLimit } = await loadLimits();

        expect(await isOverFileSizeLimit(1024)).toBe(false);
        expect(await isOverFileSizeLimit(5 * 1024 * 1024 * 1024)).toBe(false);
        expect(getStorageMock).toHaveBeenCalledTimes(2);
    });

    it("isOverFileSizeLimit refuses above a known limit, asking again before it refuses", async () => {
        getStorageMock.mockResolvedValueOnce({ max_file_size: 10 * 1024 * 1024 });
        const { isOverFileSizeLimit, refreshFileLimits } = await loadLimits();
        await refreshFileLimits();

        expect(await isOverFileSizeLimit(1024)).toBe(false);
        expect(getStorageMock).toHaveBeenCalledTimes(1);

        getStorageMock.mockResolvedValueOnce({ max_file_size: 10 * 1024 * 1024 });
        expect(await isOverFileSizeLimit(20 * 1024 * 1024)).toBe(true);

        // A plan raised meanwhile: the fresh limit lets the same file through.
        getStorageMock.mockResolvedValueOnce({ max_file_size: 50 * 1024 * 1024 });
        expect(await isOverFileSizeLimit(20 * 1024 * 1024)).toBe(false);
    });
});
