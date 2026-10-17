/**
 * The EncFile parseHTML/renderHTML round-trip (the width style, fileId) without the full NodeView UI.
 */
import { Editor, generateHTML, generateJSON } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

// The NodeView pulls in the file pipeline — mock the heavy modules before importing EncFile.
vi.mock("$lib/modules/files/download", () => ({
    getFilePayload: vi.fn(),
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

describe("EncFile schema round-trip", () => {
    const editors: Editor[] = [];

    afterEach(() => {
        while (editors.length) editors.pop()?.destroy();
        document.body.innerHTML = "";
    });

    it("renderHTML includes data-file-id and the width style", () => {
        const html = generateHTML(
            {
                type: "doc",
                content: [
                    {
                        type: "encFile",
                        attrs: {
                            fileId: "file-abc",
                            alt: "photo.png",
                            mime: "image/png",
                            width: "640px",
                        },
                    },
                ],
            },
            extensions,
        );
        expect(html).toContain('data-file-id="file-abc"');
        expect(html).toContain("640px");
        expect(html).toMatch(/width=["']?640px/);
    });

    it("parseHTML from img[data-file-id] returns the attrs", () => {
        const json = generateJSON(
            '<img data-file-id="f1" alt="a.png" data-mime="image/png" width="320px" />',
            extensions,
        );
        const node = json.content?.find((n: { type?: string }) => n.type === "encFile") as {
            attrs?: Record<string, unknown>;
        };
        expect(node?.attrs?.fileId).toBe("f1");
        expect(node?.attrs?.alt).toBe("a.png");
        expect(node?.attrs?.mime).toBe("image/png");
        expect(node?.attrs?.width).toBe("320px");
    });

    it("an Editor insert + getHTML round trip keeps the fileId", () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        const editor = new Editor({
            element: el,
            extensions,
            content: "",
        });
        editors.push(editor);
        editor
            .chain()
            .focus()
            .insertContent({
                type: "encFile",
                attrs: { fileId: "uuid-1", alt: "x.jpg", mime: "image/jpeg" },
            })
            .run();
        const html = editor.getHTML();
        expect(html).toContain("uuid-1");
        editor.commands.setContent(html);
        let found = false;
        editor.state.doc.descendants((n) => {
            if (n.type.name === "encFile" && n.attrs.fileId === "uuid-1") found = true;
        });
        expect(found).toBe(true);
    });
});
