// @vitest-environment happy-dom
/**
 * A drop into the editor against the real limit cache. On an offline cold start no limit is known:
 * the file is staged for upload instead of refused as "max 0 MB". A known limit refuses as it
 * always has.
 */
import "fake-indexeddb/auto";
import type { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_EVENTS } from "$lib/core/constants/events";

const { getStorageMock, startUploadMock } = vi.hoisted(() => ({
    getStorageMock: vi.fn(),
    startUploadMock: vi.fn(),
}));

vi.mock("$lib/core/api", () => ({ getStorage: getStorageMock }));

vi.mock("./downscale", () => ({
    downscaleImage: vi.fn((file: File) => Promise.resolve(file)),
}));

vi.mock("./opfs-staging", () => ({
    getOpfsCapability: vi.fn(() => Promise.resolve("none")),
    shouldWarnNoResume: vi.fn(() => false),
    stageFileToOpfs: vi.fn(),
    isStagingComplete: vi.fn(() => false),
    deleteStaging: vi.fn(),
    LEGACY_BLOB_MAX_BYTES: 500 * 1024 * 1024,
}));

vi.mock("./upload-manager", () => ({
    startUpload: startUploadMock,
    orphanMayResume: vi.fn(async () => true),
    reconcileSyncingUploads: vi.fn(),
}));

function makeEditor(): Editor {
    const events: Event[] = [];
    const tr = { setMeta: () => tr };
    return {
        isDestroyed: false,
        state: { tr },
        view: {
            dispatch: () => {},
            dom: {
                dispatchEvent: (event: Event) => {
                    events.push(event);
                    return true;
                },
                _events: events,
            },
        },
        chain: () => ({
            focus: () => ({
                insertContent: () => ({
                    run: () => true,
                }),
            }),
        }),
    } as unknown as Editor;
}

function editorEvents(editor: Editor): CustomEvent[] {
    return (editor.view.dom as unknown as { _events: Event[] })._events as CustomEvent[];
}

describe("a drop into the editor, by what the client knows of the limit", () => {
    beforeEach(async () => {
        // A fresh limit cache per test: the module keeps the last answer from GET /me/storage.
        vi.resetModules();
        vi.clearAllMocks();
        const { getDB } = await import("$lib/core/db");
        await (await getDB()).clear("pending-uploads");
    });

    it("an offline cold start stages a 1 KB drop instead of refusing it as 'max 0 MB'", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        getStorageMock.mockRejectedValue(new TypeError("Failed to fetch"));
        const { handleEditorImageFiles } = await import("./editor-images");
        const { getDB } = await import("$lib/core/db");
        const editor = makeEditor();
        const file = new File([new Uint8Array(1024)], "photo.png", { type: "image/png" });

        await handleEditorImageFiles(editor, [file], "note-1", null);

        expect(editorEvents(editor).find((e) => e.type === APP_EVENTS.encfileTooLarge)).toBe(
            undefined,
        );
        const rows = await (await getDB()).getAll("pending-uploads");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ name: "photo.png", note_id: "note-1" });
        expect(startUploadMock).toHaveBeenCalledOnce();
    });

    it("a known limit of 10 MB refuses a 20 MB drop with 'max 10 MB', as before", async () => {
        getStorageMock.mockResolvedValue({ max_file_size: 10 * 1024 * 1024 });
        const { handleEditorImageFiles } = await import("./editor-images");
        const { getDB } = await import("$lib/core/db");
        const editor = makeEditor();
        const file = new File([new Uint8Array(20 * 1024 * 1024)], "big.png", { type: "image/png" });

        await handleEditorImageFiles(editor, [file], "note-1", null);

        const tooLarge = editorEvents(editor).find((e) => e.type === APP_EVENTS.encfileTooLarge) as
            | CustomEvent<{ name: string; maxMB: number }>
            | undefined;
        expect(tooLarge?.detail).toEqual({ name: "big.png", maxMB: 10 });
        expect(await (await getDB()).count("pending-uploads")).toBe(0);
        expect(startUploadMock).not.toHaveBeenCalled();
    });
});
