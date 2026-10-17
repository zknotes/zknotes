// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_PREFIX } from "$lib/modules/files/refs";

// Dynamic imports inside resolveUrl → we mock db / download / blob-cache.
const getMock = vi.fn();
vi.mock("$lib/core/db", () => ({ getDB: vi.fn(async () => ({ get: getMock })) }));

const getFilePayload = vi.fn();
vi.mock("$lib/modules/files/download", () => ({ getFilePayload }));

const acquire = vi.fn();
vi.mock("$lib/modules/files/blob-cache", () => ({ acquire }));

const ensureStreamServiceWorker = vi.fn(async () => true);
vi.mock("$lib/core/streaming/sw-bridge", () => ({
    // ensureStreamServiceWorker() is called with no arguments — a spread of `unknown[]` is not a tuple,
    // so tsc refuses it (a svelte-check error). Delegate with no arguments.
    ensureStreamServiceWorker: () => ensureStreamServiceWorker(),
    initStreamBridge: vi.fn(),
}));

const { isStagingCompleteMock, createSourcePreviewUrlMock } = vi.hoisted(() => ({
    isStagingCompleteMock: vi.fn(() => false),
    createSourcePreviewUrlMock: vi.fn(() => Promise.resolve("blob:opfs-preview")),
}));
vi.mock("$lib/modules/files/opfs-staging", () => ({
    isStagingComplete: isStagingCompleteMock,
    createSourcePreviewUrl: createSourcePreviewUrlMock,
}));

import { resolveUrl } from "./enc-file-node";

beforeEach(() => {
    vi.clearAllMocks();
    ensureStreamServiceWorker.mockResolvedValue(true);
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
});

describe("resolveUrl", () => {
    it("a local: reference → our own object URL over the pending-uploads blob (owned)", async () => {
        getMock.mockResolvedValue({ blob: new Blob(["x"]), name: "pic.png" });

        const res = await resolveUrl(`${LOCAL_PREFIX}abc`);

        expect(getMock).toHaveBeenCalledWith("pending-uploads", "abc");
        expect(res).toEqual({ url: "blob:mock-url", owned: true, name: "pic.png" });
    });

    it("local: OPFS staging → preview URL from source (owned)", async () => {
        isStagingCompleteMock.mockReturnValue(true);
        getMock.mockResolvedValue({
            name: "big.png",
            mime: "image/png",
            plain_size: 100,
            staging_id: "abc",
            staging_bytes_written: 100,
        });

        const res = await resolveUrl(`${LOCAL_PREFIX}abc`);

        expect(createSourcePreviewUrlMock).toHaveBeenCalledWith("abc", "image/png", 100);
        expect(res).toEqual({ url: "blob:opfs-preview", owned: true, name: "big.png" });
    });

    it("a local: one with no pending row → it throws", async () => {
        getMock.mockResolvedValue(undefined);
        await expect(resolveUrl(`${LOCAL_PREFIX}gone`)).rejects.toThrow("pending upload not found");
    });

    it("an image → a blob-cache acquire (shared, not owned)", async () => {
        getFilePayload.mockResolvedValue({ name: "pic.png", mime: "image/png" });
        acquire.mockResolvedValue({ url: "blob:img" });

        const res = await resolveUrl("file-img");

        expect(acquire).toHaveBeenCalledWith("file-img");
        expect(res).toEqual({ url: "blob:img", owned: false, acquired: true, name: "pic.png" });
    });

    it("a declared image the sniff rules download-only → url null BUT acquired:true", async () => {
        // acquire() was called and a ref WAS taken — a release has to happen even with no URL.
        getFilePayload.mockResolvedValue({ name: "trap.png", mime: "image/png" });
        acquire.mockResolvedValue({ url: null, render: "download" });

        const res = await resolveUrl("file-trap");

        expect(res).toEqual({ url: null, owned: false, acquired: true, name: "trap.png" });
    });

    it("a declared non-image (a PDF) → a download chip with no chunk fetched (url null)", async () => {
        getFilePayload.mockResolvedValue({ name: "doc.pdf", mime: "application/pdf" });

        const res = await resolveUrl("file-pdf");

        expect(acquire).not.toHaveBeenCalled();
        expect(res).toEqual({ url: null, owned: false, name: "doc.pdf" });
    });

    it("a declared SVG (image/svg+xml) → a download chip, not a blob <img>", async () => {
        getFilePayload.mockResolvedValue({ name: "icon.svg", mime: "image/svg+xml" });

        const res = await resolveUrl("file-svg");

        expect(acquire).not.toHaveBeenCalled();
        expect(res).toEqual({ url: null, owned: false, name: "icon.svg" });
    });

    it("playable video → stream URL (owned:false, stream:true)", async () => {
        getFilePayload.mockResolvedValue({ name: "v.mp4", mime: "video/mp4" });
        HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => "maybe");

        const res = await resolveUrl("file-vid");

        expect(ensureStreamServiceWorker).toHaveBeenCalled();
        expect(res).toEqual({
            url: "/zknotes/stream/file-vid",
            owned: false,
            name: "v.mp4",
            stream: true,
        });
        expect(acquire).not.toHaveBeenCalled();
    });

    it("a playable video with no SW controller → a download chip (not a dead stream URL)", async () => {
        getFilePayload.mockResolvedValue({ name: "v.mp4", mime: "video/mp4" });
        HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => "maybe");
        ensureStreamServiceWorker.mockResolvedValue(false);

        const res = await resolveUrl("file-vid");

        expect(res).toEqual({ url: null, owned: false, name: "v.mp4" });
    });

    it("unplayable media (an AVI, say) → a download chip, with no bytes decrypted", async () => {
        getFilePayload.mockResolvedValue({ name: "clip.avi", mime: "video/x-msvideo" });
        HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => "");

        const res = await resolveUrl("file-avi");

        expect(res).toEqual({ url: null, owned: false, name: "clip.avi" });
        expect(acquire).not.toHaveBeenCalled();
        expect(ensureStreamServiceWorker).not.toHaveBeenCalled();
    });
});
