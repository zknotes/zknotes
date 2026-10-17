// @vitest-environment happy-dom
import type { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_EVENTS } from "$lib/core/constants/events";

vi.mock("./limits", () => {
    const getMaxFileSize = vi.fn(() => 1_000);
    return {
        getMaxFileSize,
        getMaxFileSizeMB: vi.fn(() => 0),
        refreshFileLimits: vi.fn().mockResolvedValue(undefined),
        // A known limit, the mocked one; the rule for an unknown limit is limits.test.ts's.
        isOverFileSizeLimit: vi.fn(async (size: number) => size > getMaxFileSize()),
    };
});

vi.mock("./downscale", () => ({
    downscaleImage: vi.fn((file: File) => Promise.resolve(file)),
}));

vi.mock("./opfs-staging", () => ({
    getOpfsCapability: vi.fn(() => Promise.resolve("none")),
    shouldWarnNoResume: vi.fn(() => false),
    stageFileToOpfs: vi.fn(),
    isStagingComplete: vi.fn(() => false),
    LEGACY_BLOB_MAX_BYTES: 500 * 1024 * 1024,
}));

vi.mock("./upload-manager", () => ({
    startUpload: vi.fn(),
}));

vi.mock("$lib/core/db", () => ({
    getDB: vi.fn(),
}));

import { handleEditorImageFiles } from "./editor-images";
import { getMaxFileSize } from "./limits";

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

describe("handleEditorImageFiles", () => {
    beforeEach(() => {
        vi.mocked(getMaxFileSize).mockReturnValue(1_000);
    });

    it("dispatches encfileTooLarge for files over the limit", async () => {
        const editor = makeEditor();
        const huge = new File([new Uint8Array(2_000)], "big.png", { type: "image/png" });

        const handled = await handleEditorImageFiles(editor, [huge], "note-1", null);

        expect(handled).toBe(true);
        const tooLarge = editorEvents(editor).find(
            (e) => e.type === APP_EVENTS.encfileTooLarge,
        ) as CustomEvent<{ name: string }>;
        expect(tooLarge?.detail.name).toBe("big.png");
        expect(editorEvents(editor).some((e) => e.type === APP_EVENTS.encfileConfirmNeeded)).toBe(
            false,
        );
    });

    it("dispatches encfileConfirmNeeded for large images", async () => {
        vi.mocked(getMaxFileSize).mockReturnValue(20 * 1024 * 1024);
        const editor = makeEditor();
        const large = new File([new Uint8Array(11 * 1024 * 1024)], "large.png", {
            type: "image/png",
        });

        await handleEditorImageFiles(editor, [large], "note-1", null);

        const confirm = editorEvents(editor).find(
            (e) => e.type === APP_EVENTS.encfileConfirmNeeded,
        ) as CustomEvent<{ files: File[] }>;
        expect(confirm?.detail.files.map((f) => f.name)).toEqual(["large.png"]);
    });

    it("dispatches encfileConfirmNeeded for non-image files within limit", async () => {
        const editor = makeEditor();
        const pdf = new File([new Uint8Array(100)], "doc.pdf", { type: "application/pdf" });

        await handleEditorImageFiles(editor, [pdf], "note-1", null);

        const confirm = editorEvents(editor).find(
            (e) => e.type === APP_EVENTS.encfileConfirmNeeded,
        ) as CustomEvent<{ files: File[] }>;
        expect(confirm?.detail.files.map((f) => f.name)).toEqual(["doc.pdf"]);
    });

    it("treats SVG as a file attach (confirm), not a silent inline image", async () => {
        vi.mocked(getMaxFileSize).mockReturnValue(20 * 1024 * 1024);
        const editor = makeEditor();
        const svg = new File([new Uint8Array(100)], "icon.svg", { type: "image/svg+xml" });

        await handleEditorImageFiles(editor, [svg], "note-1", null);

        const confirm = editorEvents(editor).find(
            (e) => e.type === APP_EVENTS.encfileConfirmNeeded,
        ) as CustomEvent<{ files: File[] }>;
        expect(confirm?.detail.files.map((f) => f.name)).toEqual(["icon.svg"]);
        expect(editorEvents(editor).some((e) => e.type === APP_EVENTS.encfileTooLarge)).toBe(false);
    });

    it("rejects only oversized files in a mixed batch", async () => {
        const editor = makeEditor();
        const ok = new File([new Uint8Array(100)], "ok.pdf", { type: "application/pdf" });
        const huge = new File([new Uint8Array(2_000)], "huge.pdf", { type: "application/pdf" });

        await handleEditorImageFiles(editor, [ok, huge], "note-1", null);

        expect(editorEvents(editor).some((e) => e.type === APP_EVENTS.encfileTooLarge)).toBe(true);
        const confirm = editorEvents(editor).find(
            (e) => e.type === APP_EVENTS.encfileConfirmNeeded,
        ) as CustomEvent<{ files: File[] }>;
        expect(confirm?.detail.files.map((f) => f.name)).toEqual(["ok.pdf"]);
    });

    it("returns false for empty file list", async () => {
        const editor = makeEditor();
        expect(await handleEditorImageFiles(editor, [], "note-1", null)).toBe(false);
    });
});
