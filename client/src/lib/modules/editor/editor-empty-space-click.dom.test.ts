import { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
    applyEmptySpaceFocus,
    emptySpaceFocusFromY,
    handleEmptySpacePointer,
    isPointerInsideProseMirror,
} from "./editor-empty-space-click";
import { Table } from "./extensions/table";
import { TableRow } from "./extensions/table-row";

describe("emptySpaceFocusFromY", () => {
    const top = 100;
    const bottom = 400;

    it("a click above the top edge → start (the padding / margin before the first image)", () => {
        expect(emptySpaceFocusFromY(50, top, bottom)).toBe("start");
        expect(emptySpaceFocusFromY(top - 1, top, bottom)).toBe("start");
    });

    it("a click below the bottom edge → end", () => {
        expect(emptySpaceFocusFromY(450, top, bottom)).toBe("end");
        expect(emptySpaceFocusFromY(bottom + 1, top, bottom)).toBe("end");
    });

    it("a click inside the content band → null (the PM / coords path)", () => {
        expect(emptySpaceFocusFromY(top, top, bottom)).toBe(null);
        expect(emptySpaceFocusFromY(250, top, bottom)).toBe(null);
        expect(emptySpaceFocusFromY(bottom, top, bottom)).toBe(null);
    });
});

describe("applyEmptySpaceFocus", () => {
    const editors: Editor[] = [];

    afterEach(() => {
        while (editors.length) editors.pop()?.destroy();
        document.body.innerHTML = "";
    });

    function makeEditor(content: string): Editor {
        const el = document.createElement("div");
        document.body.appendChild(el);
        const editor = new Editor({
            element: el,
            extensions: [
                StarterKit.configure({ link: false, underline: false }),
                Image.configure({ inline: false }),
            ],
            content,
        });
        editors.push(editor);
        return editor;
    }

    it("a start before the first image inserts an empty paragraph and a TextSelection cursor", () => {
        const editor = makeEditor('<img src="https://example.com/a.png"><p>after</p>');
        expect(editor.state.doc.firstChild?.type.name).toBe("image");
        applyEmptySpaceFocus(editor, "start");
        expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
        expect(editor.state.doc.firstChild?.content.size).toBe(0);
        expect(editor.state.selection).toBeInstanceOf(TextSelection);
        expect(editor.state.selection.empty).toBe(true);
        expect(editor.state.selection.from).toBe(1);
        // the image stays the second block
        expect(editor.state.doc.child(1)?.type.name).toBe("image");
    });

    it("a repeated start does not stack another empty line", () => {
        const editor = makeEditor('<img src="https://example.com/a.png">');
        applyEmptySpaceFocus(editor, "start");
        expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
        const countAfterFirst = editor.state.doc.childCount;
        applyEmptySpaceFocus(editor, "start");
        expect(editor.state.doc.childCount).toBe(countAfterFirst);
        expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
        expect(editor.state.selection.from).toBe(1);
    });

    it("an end after the last image inserts an empty paragraph with the cursor in it", () => {
        const editor = makeEditor('<p>before</p><img src="https://example.com/a.png">');
        applyEmptySpaceFocus(editor, "end");
        expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
        expect(editor.state.doc.lastChild?.content.size).toBe(0);
        expect(editor.state.selection).toBeInstanceOf(TextSelection);
        expect(editor.state.selection.empty).toBe(true);
    });

    it("a start with text at the beginning only places the cursor, inserting no line", () => {
        const editor = makeEditor("<p>hello</p>");
        const before = editor.state.doc.childCount;
        applyEmptySpaceFocus(editor, "start");
        expect(editor.state.doc.childCount).toBe(before);
        expect(editor.state.selection.empty).toBe(true);
        expect(editor.state.selection.from).toBe(1);
    });

    // ── A table as the first or last block — it is not an atom, but its first writable position is deep inside
    // the first cell, so a ".focus(start)" without synthesising an empty paragraph ends with the cursor inside the cell. ──
    function makeTableEditor(content: string): Editor {
        const el = document.createElement("div");
        document.body.appendChild(el);
        const editor = new Editor({
            element: el,
            extensions: [
                StarterKit.configure({ link: false, underline: false }),
                Table.configure({ resizable: false }),
                TableRow,
                TableHeader,
                TableCell,
            ],
            content,
        });
        editors.push(editor);
        return editor;
    }

    const TABLE_HTML = `<table><tr><td>a</td><td>b</td></tr></table>`;

    it("a start before a table inserts an empty paragraph, and the cursor does NOT fall into the first cell", () => {
        const editor = makeTableEditor(`${TABLE_HTML}<p>after</p>`);
        expect(editor.state.doc.firstChild?.type.name).toBe("table");
        applyEmptySpaceFocus(editor, "start");
        expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
        expect(editor.state.doc.firstChild?.content.size).toBe(0);
        expect(editor.state.selection).toBeInstanceOf(TextSelection);
        expect(editor.state.selection.from).toBe(1);
        // the table stays the second block and is still the only one — it did not duplicate.
        expect(editor.state.doc.child(1)?.type.name).toBe("table");
        expect(editor.state.doc.childCount).toBe(3);
    });

    it("a repeated start before a table does not stack another empty line", () => {
        const editor = makeTableEditor(TABLE_HTML);
        applyEmptySpaceFocus(editor, "start");
        const countAfterFirst = editor.state.doc.childCount;
        applyEmptySpaceFocus(editor, "start");
        expect(editor.state.doc.childCount).toBe(countAfterFirst);
        expect(editor.state.selection.from).toBe(1);
    });

    it("an end after a table inserts an empty paragraph with the cursor in it", () => {
        const editor = makeTableEditor(`<p>before</p>${TABLE_HTML}`);
        applyEmptySpaceFocus(editor, "end");
        expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
        expect(editor.state.doc.lastChild?.content.size).toBe(0);
        expect(editor.state.selection).toBeInstanceOf(TextSelection);
    });
});

function mouse(
    type: "click" | "mousedown",
    target: EventTarget,
    extra: MouseEventInit = {},
): MouseEvent {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...extra });
    Object.defineProperty(ev, "target", { value: target });
    return ev;
}

describe("handleEmptySpacePointer", () => {
    const editors: Editor[] = [];

    afterEach(() => {
        while (editors.length) editors.pop()?.destroy();
        document.body.innerHTML = "";
    });

    function makeEditor(content: string): Editor {
        const el = document.createElement("div");
        document.body.appendChild(el);
        const editor = new Editor({
            element: el,
            extensions: [StarterKit.configure({ link: false, underline: false })],
            content,
        });
        editors.push(editor);
        return editor;
    }

    it("isPointerInsideProseMirror: a p and the PM root are inside, the wrapper is not", () => {
        const editor = makeEditor("<p>hello world</p>");
        const pm = editor.view.dom as HTMLElement;
        const p = pm.querySelector("p");
        const wrapper = document.createElement("div");
        expect(p).toBeTruthy();
        expect(isPointerInsideProseMirror(p, pm)).toBe(true);
        expect(isPointerInsideProseMirror(pm, pm)).toBe(true);
        expect(isPointerInsideProseMirror(wrapper, pm)).toBe(false);
    });

    it("a mousedown on a paragraph is not handled — PM keeps the selection", () => {
        const editor = makeEditor("<p>hello world</p>");
        editor.commands.setTextSelection({ from: 1, to: 6 });
        const p = editor.view.dom.querySelector("p");
        expect(p).toBeTruthy();
        expect(handleEmptySpacePointer(editor, mouse("mousedown", p!))).toBe(false);
        expect(editor.state.selection.empty).toBe(false);
        expect(editor.state.selection.from).toBe(1);
        expect(editor.state.selection.to).toBe(6);
    });

    it("a click whose target is the wrapper (a drag-select mouseup in the padding) does not collapse the selection", () => {
        const editor = makeEditor("<p>hello world</p>");
        editor.commands.setTextSelection({ from: 1, to: 6 });
        const wrapper = document.createElement("div");
        expect(handleEmptySpacePointer(editor, mouse("click", wrapper))).toBe(false);
        expect(editor.state.selection.empty).toBe(false);
        expect(editor.state.selection.from).toBe(1);
        expect(editor.state.selection.to).toBe(6);
    });

    it("a mousedown on the wrapper with an empty selection is handled", () => {
        const editor = makeEditor("<p>hello world</p>");
        const wrapper = document.createElement("div");
        // jsdom rects are 0×0, so clientY > bottom → "end"
        expect(handleEmptySpacePointer(editor, mouse("mousedown", wrapper, { clientY: 10 }))).toBe(
            true,
        );
        expect(editor.state.selection.empty).toBe(true);
    });

    it("a mousedown on the PM root (the margin between a heading and a paragraph) does not collapse a multi-block selection", () => {
        const editor = makeEditor("<h1>Title</h1><p>hello world</p>");
        const from = 1;
        const to = editor.state.doc.content.size - 1;
        editor.commands.setTextSelection({ from, to });
        expect(editor.state.selection.empty).toBe(false);
        const pm = editor.view.dom;
        expect(handleEmptySpacePointer(editor, mouse("mousedown", pm))).toBe(false);
        expect(handleEmptySpacePointer(editor, mouse("click", pm))).toBe(false);
        expect(editor.state.selection.from).toBe(from);
        expect(editor.state.selection.to).toBe(to);
    });

    it("a mousedown on a heading is not handled — PM keeps the selection across the next paragraph", () => {
        const editor = makeEditor("<h1>Title</h1><p>hello world</p>");
        const from = 1;
        const to = editor.state.doc.content.size - 1;
        editor.commands.setTextSelection({ from, to });
        const h1 = editor.view.dom.querySelector("h1");
        expect(h1).toBeTruthy();
        expect(handleEmptySpacePointer(editor, mouse("mousedown", h1!))).toBe(false);
        expect(editor.state.selection.from).toBe(from);
        expect(editor.state.selection.to).toBe(to);
    });
});
