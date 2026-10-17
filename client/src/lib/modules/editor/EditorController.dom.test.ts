/**
 * EditorController's loadContent + syncMentionLabels.
 * It uses a real TipTap Editor under jsdom; it does not mount the full initTipTap (the toolbar/file deps).
 */
import { Editor } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

// The heavy Svelte and UI dependencies that initTipTap and the mention suggestion pull in — loadContent needs none of them.
vi.mock("./NoteMentionsList.svelte", () => ({ default: class NoteMentionsListStub {} }));
vi.mock("tippy.js", () => ({
    default: () => ({ destroy: () => {}, setProps: () => {}, hide: () => {}, show: () => {} }),
}));
vi.mock("$lib/modules/files/editor-images", () => ({
    handleEditorImageFiles: vi.fn(),
}));
vi.mock("$lib/modules/files/promote-inline-images", () => ({
    rewriteDataImagesInHtml: vi.fn((html: string) => ({ html, jobs: [], skipped: 0 })),
    stagePromotedImages: vi.fn(),
}));
vi.mock("$lib/modules/files/refs", () => ({
    extractFileRefs: vi.fn(() => []),
    replaceHugeDataImageTags: vi.fn((html: string) => html),
    LOCAL_PREFIX: "local:",
}));
// Stubs sufficient to import EditorController — loadContent does not call initTipTap.
vi.mock("./encrypted-file/enc-file-node", () => ({ EncFile: { name: "encFile" } }));
vi.mock("./image-resize", () => ({ ImageResize: { name: "imageResize" } }));
vi.mock("@aarkue/tiptap-math-extension", () => ({ default: { name: "math" } }));

import type { DecryptedItemMeta } from "$lib/core/data/items";
import type { NoteAutosave } from "$lib/modules/notes/NoteAutosave.svelte";
import { EditorController } from "./EditorController.svelte";
import { PopoverMenus } from "./PopoverMenus.svelte";
import type { TableUiController } from "./TableUiController.svelte";

function stubAutosave(): NoteAutosave {
    return {
        markDirty: vi.fn(),
        flush: vi.fn(),
        cancelAutosave: vi.fn(),
        isDirty: false,
    } as unknown as NoteAutosave;
}

function makeController(autosave = stubAutosave()) {
    return new EditorController({
        menus: new PopoverMenus(),
        tableUi: {} as TableUiController,
        autosave,
        getCurrentNoteId: () => "note-1",
        getAttachmentFiles: () => [],
        onUpdate: () => {},
        onFileError: () => {},
        onInstanceChange: () => {},
    });
}

/** Like CustomMention in EditorController — it needs an isBroken attr so setNodeMarkup does not drop the flag. */
const TestMention = Mention.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            isBroken: {
                default: false,
                parseHTML: (element) => element.getAttribute("data-broken") === "true",
                renderHTML: (attributes) => (attributes.isBroken ? { "data-broken": "true" } : {}),
            },
        };
    },
}).configure({
    HTMLAttributes: { class: "mention" },
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    suggestion: { char: "@", items: () => [] },
});

function makeEditor(content: string, withMention = false): Editor {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const extensions = [StarterKit, ...(withMention ? [TestMention] : [])];
    return new Editor({ element: el, extensions, content });
}

describe("EditorController.loadContent", () => {
    const editors: Editor[] = [];

    afterEach(() => {
        while (editors.length) editors.pop()?.destroy();
        document.body.innerHTML = "";
    });

    it("isProgrammaticUpdate returns to false after a successful loadContent (the finally block)", () => {
        const c = makeController();
        const editor = makeEditor("<p>a</p>");
        editors.push(editor);
        c.instance = editor;
        expect(c.isProgrammaticUpdate).toBe(false);
        c.loadContent("<p>b</p>");
        expect(c.isProgrammaticUpdate).toBe(false);
        expect(editor.getHTML()).toContain("b");
    });

    it("isProgrammaticUpdate returns to false even when EditorState.create throws (the finally block)", () => {
        const c = makeController();
        const editor = makeEditor("<p>a</p>");
        editors.push(editor);
        c.instance = editor;
        const spy = vi.spyOn(EditorState, "create").mockImplementation(() => {
            throw new Error("boom");
        });
        expect(() => c.loadContent("<p>x</p>")).toThrow("boom");
        expect(c.isProgrammaticUpdate).toBe(false);
        spy.mockRestore();
    });

    it("it resets undo/redo — a redo does not bring back the previous note's content (a cross-note leak)", () => {
        const c = makeController();
        const editor = makeEditor("<p>NoteA</p>");
        editors.push(editor);
        c.instance = editor;

        editor.commands.setContent("<p>NoteA-edited</p>");
        // The history plugin in StarterKit — an undo should be able to go back
        expect(editor.can().undo()).toBe(true);

        c.loadContent("<p>NoteB</p>");
        expect(editor.getText()).toContain("NoteB");
        // After EditorState.create the history is empty
        expect(editor.can().undo()).toBe(false);
        expect(editor.can().redo()).toBe(false);
        // An explicit redo must not bring NoteA back
        editor.commands.redo();
        expect(editor.getText()).not.toContain("NoteA");
        expect(editor.getText()).toContain("NoteB");
    });

    it("highlightChanges=false does not set dirty through markDirty", () => {
        const autosave = stubAutosave();
        const c = makeController(autosave);
        const editor = makeEditor("<p>a</p>");
        editors.push(editor);
        c.instance = editor;
        c.loadContent("<p>fresh</p>", false);
        expect(autosave.markDirty).not.toHaveBeenCalled();
    });
});

describe("EditorController.syncMentionLabels", () => {
    const editors: Editor[] = [];

    afterEach(() => {
        while (editors.length) editors.pop()?.destroy();
        document.body.innerHTML = "";
    });

    it("it updates the label without markDirty and with addToHistory false", () => {
        const autosave = stubAutosave();
        const c = makeController(autosave);
        const editor = makeEditor("<p>hi</p>", true);
        editors.push(editor);
        c.instance = editor;

        editor
            .chain()
            .focus()
            .insertContent({
                type: "mention",
                attrs: { id: "n2", label: "Old Title" },
            })
            .run();

        // By hand: the history holds an insert; the sync must not add another undo step for the label
        const historyBefore = editor.can().undo();

        const notes = [{ id: "n2", title: "New Title", type: "note" }] as DecryptedItemMeta[];

        const changed = c.syncMentionLabels(notes);
        expect(changed).toBe(true);
        expect(editor.getHTML()).toContain("New Title");
        expect(autosave.markDirty).not.toHaveBeenCalled();
        expect(c.isProgrammaticUpdate).toBe(false);

        // An undo must not bring "Old Title" back as the first step after the label sync — if
        // addToHistory is false, the undo goes to the mention insert or earlier, not to the label patch.
        // Strictest: one undo must not leave a broken state; after the sync the label stays New until
        // the mention insert itself is undone.
        if (historyBefore) {
            editor.commands.undo();
            // After the insert is undone the mention may disappear; "Old Title" must not be in the doc
            // from a sync transaction.
            expect(editor.getHTML()).not.toContain("Old Title");
        }
    });

    it("it marks isBroken when a note disappears from the list", () => {
        const c = makeController();
        const editor = makeEditor("<p></p>", true);
        editors.push(editor);
        c.instance = editor;
        editor
            .chain()
            .focus()
            .insertContent({
                type: "mention",
                attrs: { id: "gone", label: "Gone" },
            })
            .run();

        const changed = c.syncMentionLabels([]);
        expect(changed).toBe(true);
        let sawBroken = false;
        editor.state.doc.descendants((node) => {
            if (node.type.name === "mention" && node.attrs.isBroken === true) sawBroken = true;
        });
        expect(sawBroken).toBe(true);
    });

    it("changed=false → no dispatch when nothing changes", () => {
        const c = makeController();
        const editor = makeEditor("<p></p>", true);
        editors.push(editor);
        c.instance = editor;
        editor
            .chain()
            .focus()
            .insertContent({
                type: "mention",
                attrs: { id: "n1", label: "Same" },
            })
            .run();

        const dispatch = vi.spyOn(editor.view, "dispatch");
        const notes = [{ id: "n1", title: "Same", type: "note" }] as DecryptedItemMeta[];
        expect(c.syncMentionLabels(notes)).toBe(false);
        expect(dispatch).not.toHaveBeenCalled();
        dispatch.mockRestore();
    });
});

describe("EditorState.create history isolation", () => {
    it("a fresh state carries no undo steps from the old one", () => {
        const el = document.createElement("div");
        document.body.appendChild(el);
        const editor = new Editor({
            element: el,
            extensions: [StarterKit],
            content: "<p>one</p>",
        });
        editor.commands.insertContent("<p>two</p>");
        expect(editor.can().undo()).toBe(true);

        const fresh = EditorState.create({
            doc: editor.state.doc,
            plugins: editor.state.plugins,
            schema: editor.schema,
        });
        editor.view.updateState(fresh);
        expect(editor.can().undo()).toBe(false);
        editor.destroy();
        el.remove();
    });
});
