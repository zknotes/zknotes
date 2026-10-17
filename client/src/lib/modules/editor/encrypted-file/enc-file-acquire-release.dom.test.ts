/**
 * The acquire/release balance — resolveUrl's branches.
 * Environment: vitest project `dom` (jsdom).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
vi.mock("$lib/core/db", () => ({ getDB: vi.fn(async () => ({ get: getMock })) }));

const getFilePayload = vi.fn();
vi.mock("$lib/modules/files/download", () => ({ getFilePayload }));

const acquire = vi.fn();
const release = vi.fn();
vi.mock("$lib/modules/files/blob-cache", () => ({ acquire, release }));

const ensureStreamServiceWorker = vi.fn(async () => true);
vi.mock("$lib/core/streaming/sw-bridge", () => ({
    ensureStreamServiceWorker: () => ensureStreamServiceWorker(),
    initStreamBridge: vi.fn(),
}));

vi.mock("$lib/modules/files/opfs-staging", () => ({
    isStagingComplete: vi.fn(() => false),
    createSourcePreviewUrl: vi.fn(),
}));

import { resolveUrl } from "./enc-file-node";

/**
 * A simulation of the NodeView revoke contract:
 * release ONLY when the resolve returned acquired:true.
 */
function simulatedRevoke(result: Awaited<ReturnType<typeof resolveUrl>>, fileId: string): void {
    if (result.owned && result.url?.startsWith("blob:")) {
        URL.revokeObjectURL(result.url);
    } else if (result.acquired) {
        release(fileId);
    }
}

beforeEach(() => {
    vi.clearAllMocks();
    ensureStreamServiceWorker.mockResolvedValue(true);
    URL.createObjectURL = vi.fn(() => "blob:owned");
    URL.revokeObjectURL = vi.fn();
});

describe("encFile acquire/release contract", () => {
    it("a raster image: acquire once; a simulated destroy → release once", async () => {
        getFilePayload.mockResolvedValue({ name: "a.png", mime: "image/png" });
        acquire.mockResolvedValue({ url: "blob:img" });

        const res = await resolveUrl("img-1");
        expect(res.acquired).toBe(true);
        expect(acquire).toHaveBeenCalledTimes(1);

        simulatedRevoke(res, "img-1");
        expect(release).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledWith("img-1");
    });

    it("a PDF chip: no acquire → destroy does not call release", async () => {
        getFilePayload.mockResolvedValue({ name: "d.pdf", mime: "application/pdf" });
        const res = await resolveUrl("pdf-1");
        expect(res.acquired).toBeFalsy();
        expect(acquire).not.toHaveBeenCalled();
        simulatedRevoke(res, "pdf-1");
        expect(release).not.toHaveBeenCalled();
    });

    it("a streamed video: no acquire → destroy does not call release", async () => {
        getFilePayload.mockResolvedValue({ name: "v.mp4", mime: "video/mp4" });
        HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => "maybe");
        const res = await resolveUrl("vid-1");
        expect(res.stream).toBe(true);
        expect(res.acquired).toBeFalsy();
        simulatedRevoke(res, "vid-1");
        expect(release).not.toHaveBeenCalled();
    });

    it("a download-only sniff (url null, acquired true): destroy still releases", async () => {
        getFilePayload.mockResolvedValue({ name: "trap.png", mime: "image/png" });
        acquire.mockResolvedValue({ url: null, render: "download" });
        const res = await resolveUrl("trap-1");
        expect(res.acquired).toBe(true);
        expect(res.url).toBeNull();
        simulatedRevoke(res, "trap-1");
        expect(release).toHaveBeenCalledTimes(1);
    });
});
