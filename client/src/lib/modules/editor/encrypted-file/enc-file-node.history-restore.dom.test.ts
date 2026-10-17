/**
 * Regression: a file embed is a live reference — a history restore brings back the old alt
 * from the snapshot for the SAME fileId (HistoryPanel.svelte restore() → editor.commands.setContent).
 * NodeView.update() (enc-file-node.ts addNodeView) has to re-resolve rather than just overwrite the
 * img/node alt out of the doc, because otherwise it would show a stale name after the restore.
 */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

const getFilePayload = vi.fn();
vi.mock("$lib/modules/files/download", () => ({
    getFilePayload,
    FileDeletedError: class FileDeletedError extends Error {
        name = "FileDeletedError";
    },
}));
vi.mock("$lib/modules/files/blob-cache", () => ({
    acquire: vi.fn(),
    release: vi.fn(),
}));
vi.mock("$lib/modules/files/file-invalidator", () => ({
    onFileInvalidated: vi.fn(() => () => {}),
}));
vi.mock("$lib/modules/files/upload-manager", () => ({
    abortPendingUpload: vi.fn(),
    getUploadState: vi.fn(),
    retryUpload: vi.fn(),
    subscribeUpload: vi.fn(() => () => {}),
}));

import { EncFile } from "./enc-file-node";

const extensions = [StarterKit, EncFile];

function currentAlt(editor: Editor): string | undefined {
    let alt: string | undefined;
    editor.state.doc.descendants((n) => {
        if (n.type.name === "encFile") alt = n.attrs.alt;
    });
    return alt;
}

describe("EncFile live reference — history restore", () => {
    const editors: Editor[] = [];

    afterEach(() => {
        while (editors.length) editors.pop()?.destroy();
        document.body.innerHTML = "";
        vi.clearAllMocks();
    });

    it("setContent with an old alt (a history snapshot) for the same fileId re-resolves to the current name", async () => {
        // The live name in the vault is always "v2.pdf" (renamed after the snapshot was saved).
        getFilePayload.mockResolvedValue({ name: "v2.pdf", mime: "application/pdf" });

        const el = document.createElement("div");
        document.body.appendChild(el);
        const editor = new Editor({
            element: el,
            extensions,
            content: {
                type: "doc",
                content: [
                    {
                        type: "encFile",
                        attrs: { fileId: "file-1", alt: "v1.pdf", mime: "application/pdf" },
                    },
                ],
            },
        });
        editors.push(editor);

        // Wait for the initial resolveUrl → the alt self-heals to "v2.pdf".
        await vi.waitFor(() => expect(currentAlt(editor)).toBe("v2.pdf"));

        // Restore: setContent brings back the OLD alt from the snapshot for the SAME fileId.
        editor.commands.setContent({
            type: "doc",
            content: [
                {
                    type: "encFile",
                    attrs: { fileId: "file-1", alt: "v1.pdf", mime: "application/pdf" },
                },
            ],
        });

        // A live reference: it must not stay stuck on the stale "v1.pdf".
        await vi.waitFor(() => expect(currentAlt(editor)).toBe("v2.pdf"));
    });
});
