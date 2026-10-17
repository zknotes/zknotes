/**
 * Removing an image that is still uploading, by editing: the same grace and toast as for an
 * uploaded file, then an abort — and an upload that finishes inside the grace is placed by how the
 * grace ends.
 *
 * A real TipTap editor with the encFile node, NoteFileEvents, pending-trash and upload-manager over
 * fake-indexeddb. Mocked: the upload pipeline (`./upload`), the stored-note patch (`./cleanup`),
 * FileService, the toasts, and what the NodeView loads for a real file.
 */
import "fake-indexeddb/auto";
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalItem, PendingUpload } from "$lib/core/db";

const mocks = vi.hoisted(() => ({
    startNewUpload: vi.fn(),
    swapFileRefInNoteContent: vi.fn(async () => false),
    trash: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    toastAdd: vi.fn(
        (_toast: { message: string; action?: { label: string; onClick: () => void } }) => "toast-1",
    ),
}));

vi.mock("./upload", () => ({
    startNewUpload: mocks.startNewUpload,
    resumeUpload: vi.fn(),
    replaceFileContent: vi.fn(),
    computeUploadDisplayPct: () => 0,
}));
vi.mock("./cleanup", () => ({ swapFileRefInNoteContent: mocks.swapFileRefInNoteContent }));
vi.mock("./files-changed-bus", () => ({ emitFilesChanged: vi.fn(), emitNotesChanged: vi.fn() }));
vi.mock("./file-service", () => ({
    FileService: { trash: mocks.trash, restore: mocks.restore },
}));
vi.mock("$lib/core/stores/toast.svelte", () => ({
    globalToasts: { add: mocks.toastAdd, remove: vi.fn() },
}));
// What the NodeView would load for a real file.
vi.mock("$lib/modules/files/download", () => ({
    getFilePayload: vi.fn(async () => null),
    FileDeletedError: class FileDeletedError extends Error {
        name = "FileDeletedError";
    },
}));
vi.mock("$lib/modules/files/blob-cache", () => ({ acquire: vi.fn(), release: vi.fn() }));
vi.mock("$lib/modules/files/file-invalidator", () => ({
    onFileInvalidated: vi.fn(() => () => {}),
}));
// The real upload-manager, with a spy on the abort the end of the grace calls (the other-tab check
// sits in front of it).
vi.mock("./upload-manager", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./upload-manager")>();
    return { ...actual, abortRemovedUpload: vi.fn(actual.abortRemovedUpload) };
});

import { getDB } from "$lib/core/db";
import { EncFile } from "$lib/modules/editor/encrypted-file/enc-file-node";
import { insertEncFile } from "./editor-images";
import { NoteFileEvents } from "./NoteFileEvents.svelte";
import { PENDING_TRASH_GRACE_MS, pendingTrashManager } from "./pending-trash";
import { abortPendingUpload, abortRemovedUpload, startUpload } from "./upload-manager";

// A fresh upload per test: removed-uploads keeps its marks for the page session, as the app does.
let seq = 0;
let LOCAL_ID = "";
let LOCAL_REF = "";

function fileIds(editor: Editor): string[] {
    const ids: string[] = [];
    editor.state.doc.descendants((n) => {
        if (n.type.name === "encFile") ids.push(n.attrs.fileId as string);
    });
    return ids;
}

function uploadedItem(id: string): LocalItem {
    return {
        id,
        type: "file",
        parent_id: "note-1",
        encrypted_payload: "enc",
        payload_nonce: "nonce",
        encrypted_item_key: "ik",
        item_key_nonce: "ikn",
        chunk_set_id: "cs-1",
        chunk_count: 1,
        ciphertext_size: 48,
        sort_order: id,
        version: 1,
        dirty: true,
        localRev: 0,
    } as LocalItem;
}

function pendingRow(localId: string): PendingUpload {
    return {
        local_id: localId,
        phase: "staging_source",
        blob: new File([new Uint8Array([1])], "pic.png", { type: "image/png" }),
        name: "pic.png",
        mime: "image/png",
        plain_size: 1,
        note_id: "note-1",
        parent_id: "note-1",
        created_at: 1,
        last_activity_at: 1,
        manifest: {},
    };
}

/**
 * A real keydown on the editor, the way the browser delivers it. TipTap's `keyboardShortcut` command
 * would not do: it captures the transaction the key makes and re-applies only its steps, so an undo
 * loses the history meta that marks it.
 */
function press(editor: Editor, key: string, opts: KeyboardEventInit = {}): void {
    editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }),
    );
}

/** Ctrl+Z (jsdom is not a Mac, so Mod is Ctrl). */
function ctrlZ(editor: Editor): void {
    press(editor, "z", { ctrlKey: true });
}

/** Ctrl+Y, the redo. */
function ctrlY(editor: Editor): void {
    press(editor, "y", { ctrlKey: true });
}

/** Inserts an upload's node the way the editor does — an undo step of its own. */
function insertUploadNode(editor: Editor, fileId: string): void {
    editor.commands.setTextSelection(1);
    editor.commands.insertContent({
        type: "encFile",
        attrs: { fileId, alt: "new.png", mime: "image/png" },
    });
}

/** Backspace on the node, the way the user removes it. */
function backspaceOn(editor: Editor, fileId: string): void {
    let pos = -1;
    editor.state.doc.descendants((n, p) => {
        if (n.type.name === "encFile" && n.attrs.fileId === fileId) pos = p;
    });
    expect(pos).toBeGreaterThanOrEqual(0);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    press(editor, "Backspace");
}

function undoToast(): { onClick: () => void } | undefined {
    const withUndo = mocks.toastAdd.mock.calls
        .map(([toast]) => toast)
        .filter((toast) => toast.action?.label === "Undo");
    return withUndo.at(-1)?.action;
}

/** A pipeline run that finishes only when the test says so. */
function holdPipeline(): (item: LocalItem) => void {
    let finish!: (item: LocalItem) => void;
    mocks.startNewUpload.mockImplementation(
        () =>
            new Promise<LocalItem>((resolve) => {
                finish = resolve;
            }),
    );
    return (item) => finish(item);
}

describe("removing an image that is still uploading", () => {
    let editor: Editor;
    let unmount: () => void;

    beforeEach(async () => {
        vi.clearAllMocks();
        LOCAL_ID = `loc-${++seq}`;
        LOCAL_REF = `local:${LOCAL_ID}`;
        const db = await getDB();
        await db.clear("pending-uploads");
        await db.clear("items");
        await db.put("pending-uploads", pendingRow(LOCAL_ID));

        const el = document.createElement("div");
        document.body.appendChild(el);
        editor = new Editor({
            element: el,
            extensions: [StarterKit, EncFile],
            content:
                `<p>before</p><img data-file-id="${LOCAL_REF}" alt="pic.png" data-mime="image/png">` +
                `<p>middle</p><img data-file-id="file-9" alt="old.png" data-mime="image/png"><p>after</p>`,
        });
        unmount = new NoteFileEvents().mount(editor, "note-1");
        // TipTap's own create tick, before the grace timer is faked.
        await new Promise((r) => setTimeout(r, 0));
    });

    afterEach(async () => {
        vi.useRealTimers();
        pendingTrashManager.cancelAll();
        unmount();
        editor.destroy();
        document.body.innerHTML = "";
    });

    it("Backspace shows the Undo toast; when the grace runs out the upload is aborted", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        backspaceOn(editor, LOCAL_REF);

        expect(fileIds(editor)).toEqual(["file-9"]);
        expect(pendingTrashManager.isPending(LOCAL_REF)).toBe(true);
        expect(undoToast()).toBeDefined();
        expect(abortRemovedUpload).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        vi.useRealTimers();

        await vi.waitFor(() => expect(abortRemovedUpload).toHaveBeenCalledWith(LOCAL_ID));
        await vi.waitFor(async () =>
            expect(await (await getDB()).get("pending-uploads", LOCAL_ID)).toBeUndefined(),
        );
        expect(mocks.trash).not.toHaveBeenCalled();
    });

    it("Undo inside the grace brings the node back and the upload goes on", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        backspaceOn(editor, LOCAL_REF);
        undoToast()?.onClick();

        expect(fileIds(editor)).toEqual([LOCAL_REF, "file-9"]);
        expect(pendingTrashManager.isPending(LOCAL_REF)).toBe(false);

        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        vi.useRealTimers();

        expect(abortRemovedUpload).not.toHaveBeenCalled();
        expect(await (await getDB()).get("pending-uploads", LOCAL_ID)).toBeDefined();
    });

    it("a finished upload swaps the node and points the stored note at the file before its row goes", async () => {
        const rowsAtRepoint: unknown[] = [];
        mocks.swapFileRefInNoteContent.mockImplementationOnce(async () => {
            rowsAtRepoint.push(await (await getDB()).get("pending-uploads", LOCAL_ID));
            return true;
        });
        mocks.startNewUpload.mockResolvedValue(uploadedItem("file-real"));

        await startUpload(editor, pendingRow(LOCAL_ID));

        expect(fileIds(editor)).toEqual(["file-real", "file-9"]);
        // One look is enough with the editor swapped: a note that does not store the ref yet gets
        // the real id from the editor's own save.
        expect(mocks.swapFileRefInNoteContent).toHaveBeenCalledWith(
            "note-1",
            LOCAL_REF,
            "file-real",
            1,
        );
        // The row is the only record of which file the `local:` ref became — it is still there.
        expect(rowsAtRepoint[0]).toBeDefined();
        expect(await (await getDB()).get("pending-uploads", LOCAL_ID)).toBeUndefined();
    });

    it("an upload that finishes inside the grace goes to the Trash when the grace runs out", async () => {
        const finish = holdPipeline();
        const run = startUpload(editor, pendingRow(LOCAL_ID));
        await vi.waitFor(() => expect(mocks.startNewUpload).toHaveBeenCalled());
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        backspaceOn(editor, LOCAL_REF);
        finish(uploadedItem("file-real"));
        await run;

        // Nothing to swap in the editor, and the stored note is not patched behind the grace's back.
        expect(fileIds(editor)).toEqual(["file-9"]);
        expect(mocks.swapFileRefInNoteContent).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        vi.useRealTimers();

        await vi.waitFor(() => expect(mocks.trash).toHaveBeenCalledWith("file-real"));
        expect(abortRemovedUpload).not.toHaveBeenCalled();
    });

    it("Undo after the upload finished inside the grace gives the node the real file id", async () => {
        const finish = holdPipeline();
        const run = startUpload(editor, pendingRow(LOCAL_ID));
        await vi.waitFor(() => expect(mocks.startNewUpload).toHaveBeenCalled());
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        backspaceOn(editor, LOCAL_REF);
        finish(uploadedItem("file-real"));
        await run;
        undoToast()?.onClick();
        vi.useRealTimers();

        await vi.waitFor(() => expect(fileIds(editor)).toEqual(["file-real", "file-9"]));
        // Outside the history: the next undo does not turn it back into the local: reference.
        editor.commands.undo();
        expect(fileIds(editor)).toEqual(["file-real", "file-9"]);
        expect(mocks.trash).not.toHaveBeenCalled();
        expect(abortRemovedUpload).not.toHaveBeenCalled();
    });

    it("the pipeline swapping in the real id is not a removal", async () => {
        mocks.startNewUpload.mockResolvedValue(uploadedItem("file-real"));

        await startUpload(editor, pendingRow(LOCAL_ID));

        expect(fileIds(editor)).toEqual(["file-real", "file-9"]);
        expect(pendingTrashManager.pendingFileIds).toEqual([]);
        expect(undoToast()).toBeUndefined();
    });

    it("Abort on the node removes it at once, with no grace and no toast", async () => {
        await abortPendingUpload(editor, LOCAL_ID);

        expect(fileIds(editor)).toEqual(["file-9"]);
        expect(pendingTrashManager.pendingFileIds).toEqual([]);
        expect(undoToast()).toBeUndefined();
    });

    it("a change kept out of the history — a promotion rolled back — is not a removal", () => {
        let pos = -1;
        editor.state.doc.descendants((n, p) => {
            if (n.type.name === "encFile" && n.attrs.fileId === LOCAL_REF) pos = p;
        });
        const node = editor.state.doc.nodeAt(pos);
        editor.view.dispatch(
            editor.state.tr.delete(pos, pos + (node?.nodeSize ?? 1)).setMeta("addToHistory", false),
        );

        expect(fileIds(editor)).toEqual(["file-9"]);
        expect(pendingTrashManager.pendingFileIds).toEqual([]);
    });

    it("Ctrl+Z inside the grace cancels the removal as the toast does", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        backspaceOn(editor, LOCAL_REF);
        ctrlZ(editor);

        expect(fileIds(editor)).toEqual([LOCAL_REF, "file-9"]);
        expect(pendingTrashManager.isPending(LOCAL_REF)).toBe(false);
        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        vi.useRealTimers();
        expect(abortRemovedUpload).not.toHaveBeenCalled();
    });

    it("an undo after the grace, for an upload that had finished, brings its file back", async () => {
        const finish = holdPipeline();
        const run = startUpload(editor, pendingRow(LOCAL_ID));
        await vi.waitFor(() => expect(mocks.startNewUpload).toHaveBeenCalled());
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        backspaceOn(editor, LOCAL_REF);
        finish(uploadedItem("file-real"));
        await run;
        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        vi.useRealTimers();
        await vi.waitFor(() => expect(mocks.trash).toHaveBeenCalledWith("file-real"));
        await (await getDB()).put("items", { ...uploadedItem("file-real"), deleted_at: 1 });

        ctrlZ(editor);

        await vi.waitFor(() => expect(fileIds(editor)).toEqual(["file-real", "file-9"]));
        await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledWith("file-real"));
    });

    // The branch these rely on never ran before: prosemirror-history marks its transactions under its
    // plugin key, and the check read the meta "history".
    it("an uploaded file: Ctrl+Z inside the grace keeps it out of the Trash", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        backspaceOn(editor, "file-9");
        expect(pendingTrashManager.isPending("file-9")).toBe(true);
        ctrlZ(editor);

        expect(pendingTrashManager.isPending("file-9")).toBe(false);
        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        vi.useRealTimers();
        expect(mocks.trash).not.toHaveBeenCalled();
    });

    it("an uploaded file: Ctrl+Z after the grace brings it back from the Trash", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        backspaceOn(editor, "file-9");
        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        vi.useRealTimers();
        await vi.waitFor(() => expect(mocks.trash).toHaveBeenCalledWith("file-9"));
        await (await getDB()).put("items", { ...uploadedItem("file-9"), deleted_at: 1 });

        ctrlZ(editor);

        expect(fileIds(editor)).toEqual([LOCAL_REF, "file-9"]);
        await vi.waitFor(() => expect(mocks.restore).toHaveBeenCalledWith("file-9"));
    });

    // The swap to the real id is outside the history: in it, an undo that came within the grouping
    // delay took the swap back together with the removal, and the node returned as a dead `local:`.
    it("an undo right after the upload's swap brings the node back under its real id", async () => {
        mocks.startNewUpload.mockResolvedValue(uploadedItem("file-real"));
        await startUpload(editor, pendingRow(LOCAL_ID));
        expect(fileIds(editor)).toEqual(["file-real", "file-9"]);

        backspaceOn(editor, "file-real");
        ctrlZ(editor);

        expect(fileIds(editor)).toEqual(["file-real", "file-9"]);
        expect(pendingTrashManager.isPending("file-real")).toBe(false);
    });

    it("a redo of an undone insertion brings the real id back and keeps the file out of the Trash", async () => {
        const newId = `${LOCAL_ID}-new`;
        await (await getDB()).put("pending-uploads", pendingRow(newId));
        insertUploadNode(editor, `local:${newId}`);
        await new Promise((r) => setTimeout(r, 600)); // the upload takes its time
        mocks.startNewUpload.mockResolvedValue(uploadedItem("file-new"));
        await startUpload(editor, pendingRow(newId));
        expect(fileIds(editor)).toContain("file-new");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        ctrlZ(editor); // takes the insertion back: the node goes, under its real id
        expect(fileIds(editor)).not.toContain("file-new");
        expect(pendingTrashManager.isPending("file-new")).toBe(true);
        ctrlY(editor); // the redo is computed from the doc of the undo — the real id

        expect(fileIds(editor)).toContain("file-new");
        expect(fileIds(editor)).not.toContain(`local:${newId}`);
        expect(pendingTrashManager.isPending("file-new")).toBe(false);
        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        vi.useRealTimers();
        expect(mocks.trash).not.toHaveBeenCalled();
    });

    it("the toast's Undo that takes back the insertion as well lets the removal stand", async () => {
        const newId = `${LOCAL_ID}-new`;
        insertUploadNode(editor, `local:${newId}`);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        // Within the grouping delay: one undo step for the insertion and the removal.
        backspaceOn(editor, `local:${newId}`);
        expect(pendingTrashManager.isPending(`local:${newId}`)).toBe(true);
        undoToast()?.onClick();

        expect(fileIds(editor)).not.toContain(`local:${newId}`);
        vi.useRealTimers();
        await vi.waitFor(() => expect(abortRemovedUpload).toHaveBeenCalledWith(newId));
    });

    // Within the grouping delay prosemirror-history would join the removal to the insertion, and the
    // undo would take both back: an automated test removes the node that fast, a person rarely does.
    it("a removal right after the editor inserts the file is its own undo step", async () => {
        const newId = `${LOCAL_ID}-new`;
        editor.commands.setTextSelection(1);
        insertEncFile(editor, `local:${newId}`, "new.png", "image/png");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        backspaceOn(editor, `local:${newId}`);
        undoToast()?.onClick();

        expect(fileIds(editor)).toContain(`local:${newId}`);
        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        vi.useRealTimers();
        expect(abortRemovedUpload).not.toHaveBeenCalled();
    });
});
