/**
 * The "not downloaded on this device" state of the encFile NodeView. On a device whose
 * auto-download policy did not fetch the chunks, `acquire` rejects with FileNotLocalError. That is
 * not a load failure: the node shows a placeholder in the image's box with a tap to load, and it
 * resolves on its own once the chunks arrive by any path (`file-local`).
 */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyFileLocal } from "$lib/modules/files/file-invalidator";

const getFilePayload = vi.fn();
class FileNotLocalError extends Error {
    name = "FileNotLocalError";
}
vi.mock("$lib/modules/files/download", () => ({
    getFilePayload,
    FileNotLocalError,
    FileDeletedError: class FileDeletedError extends Error {
        name = "FileDeletedError";
    },
}));
const acquire = vi.fn();
const release = vi.fn();
vi.mock("$lib/modules/files/blob-cache", () => ({ acquire, release }));
vi.mock("$lib/modules/files/upload-manager", () => ({
    abortPendingUpload: vi.fn(),
    getUploadState: vi.fn(),
    retryUpload: vi.fn(),
    subscribeUpload: vi.fn(() => () => {}),
}));

import { NOT_LOCAL_ATTR } from "./enc-file-overlay";
import { EncFile } from "./enc-file-node";

const extensions = [StarterKit, EncFile];
const CARD = `[${NOT_LOCAL_ATTR}]`;

function mount(attrs: Record<string, unknown>): { editor: Editor; el: HTMLElement } {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const editor = new Editor({
        element: el,
        extensions,
        content: { type: "doc", content: [{ type: "encFile", attrs }] },
    });
    return { editor, el };
}

describe("EncFile — not downloaded on this device", () => {
    const editors: Editor[] = [];

    afterEach(() => {
        while (editors.length) editors.pop()?.destroy();
        document.body.innerHTML = "";
        vi.clearAllMocks();
    });

    it("FileNotLocalError → a placeholder in the image's box, not the generic error", async () => {
        getFilePayload.mockResolvedValue({ name: "pic.png", mime: "image/png" });
        acquire.mockRejectedValue(new FileNotLocalError("not local"));

        const { editor, el } = mount({
            fileId: "file-1",
            alt: "pic.png",
            mime: "image/png",
            w: 640,
            h: 480,
        });
        editors.push(editor);

        await vi.waitFor(() => expect(el.querySelector(CARD)).not.toBeNull());
        const card = el.querySelector(CARD) as HTMLElement;
        expect(card.getAttribute(NOT_LOCAL_ATTR)).toBe("idle");
        expect(card.textContent).toContain("not downloaded on this device");
        // The same box as the image would take — no layout jump when it loads.
        expect(card.style.width).toBe("640px");
        expect(card.style.aspectRatio).toBe("640 / 480");
        const img = el.querySelector("span.encfile-node img") as HTMLImageElement;
        expect(img.alt).not.toContain("could not load");
        expect(img.style.display).toBe("none");
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(acquire).toHaveBeenCalledWith("file-1");
    });

    it("a tap on the placeholder loads with force and renders the image", async () => {
        getFilePayload.mockResolvedValue({ name: "pic.png", mime: "image/png" });
        acquire.mockImplementation(async (_id: string, opts?: { force?: boolean }) => {
            if (opts?.force) return { url: "blob:img", render: "raster" };
            throw new FileNotLocalError("not local");
        });

        const { editor, el } = mount({ fileId: "file-1", alt: "pic.png", mime: "image/png" });
        editors.push(editor);

        await vi.waitFor(() => expect(el.querySelector(CARD)).not.toBeNull());
        (el.querySelector(CARD) as HTMLElement).click();

        await vi.waitFor(() => {
            const img = el.querySelector("span.encfile-node img") as HTMLImageElement;
            expect(img.getAttribute("src")).toBe("blob:img");
        });
        expect(acquire).toHaveBeenLastCalledWith("file-1", { force: true });
        expect(el.querySelector(CARD)).toBeNull();
        const img = el.querySelector("span.encfile-node img") as HTMLImageElement;
        expect(img.style.display).toBe("");
    });

    it("the file-local event re-resolves the placeholder without a refresh", async () => {
        getFilePayload.mockResolvedValue({ name: "pic.png", mime: "image/png" });
        acquire.mockRejectedValueOnce(new FileNotLocalError("not local"));

        const { editor, el } = mount({ fileId: "file-1", alt: "pic.png", mime: "image/png" });
        editors.push(editor);
        await vi.waitFor(() => expect(el.querySelector(CARD)).not.toBeNull());

        // Another path (Info → Load preview, a pin, another tab) filled the chunk cache.
        acquire.mockResolvedValue({ url: "blob:img", render: "raster" });
        notifyFileLocal("file-1");

        await vi.waitFor(() => {
            const img = el.querySelector("span.encfile-node img") as HTMLImageElement;
            expect(img.getAttribute("src")).toBe("blob:img");
        });
        expect(el.querySelector(CARD)).toBeNull();
        // The re-resolve is a normal one — the chunks are local now, so no force is needed.
        expect(acquire).toHaveBeenLastCalledWith("file-1");
    });

    it("the file-local event is ignored once the image is already on screen", async () => {
        getFilePayload.mockResolvedValue({ name: "pic.png", mime: "image/png" });
        acquire.mockResolvedValue({ url: "blob:img", render: "raster" });

        const { editor, el } = mount({ fileId: "file-1", alt: "pic.png", mime: "image/png" });
        editors.push(editor);
        await vi.waitFor(() => {
            const img = el.querySelector("span.encfile-node img") as HTMLImageElement;
            expect(img.getAttribute("src")).toBe("blob:img");
        });

        notifyFileLocal("file-1");
        await new Promise((r) => setTimeout(r, 10));
        expect(acquire).toHaveBeenCalledTimes(1);
    });

    it("a failed forced load keeps the card with a Retry instead of a dead alt text", async () => {
        getFilePayload.mockResolvedValue({ name: "pic.png", mime: "image/png" });
        acquire.mockImplementation(async (_id: string, opts?: { force?: boolean }) => {
            if (opts?.force) throw new Error("network down");
            throw new FileNotLocalError("not local");
        });

        const { editor, el } = mount({ fileId: "file-1", alt: "pic.png", mime: "image/png" });
        editors.push(editor);
        await vi.waitFor(() => expect(el.querySelector(CARD)).not.toBeNull());
        (el.querySelector(CARD) as HTMLElement).click();

        await vi.waitFor(() =>
            expect(el.querySelector(CARD)?.getAttribute(NOT_LOCAL_ATTR)).toBe("error"),
        );
        expect(el.querySelector(`${CARD} button`)?.textContent).toBe("Retry");
    });

    it("any other error still shows the generic failure", async () => {
        getFilePayload.mockResolvedValue({ name: "pic.png", mime: "image/png" });
        acquire.mockRejectedValue(new Error("boom"));

        const { editor, el } = mount({ fileId: "file-1", alt: "pic.png", mime: "image/png" });
        editors.push(editor);

        await vi.waitFor(() => {
            const img = el.querySelector("span.encfile-node img") as HTMLImageElement;
            expect(img.alt).toBe("⚠ could not load file");
        });
        expect(el.querySelector(CARD)).toBeNull();
    });
});
