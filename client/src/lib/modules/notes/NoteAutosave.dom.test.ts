/**
 * NoteAutosave: deriveTitle; the baseline per note id; the conflict/gone branches.
 * Environment: vitest project `dom` (jsdom).
 */
import type { QueryClient } from "@tanstack/svelte-query";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateItemPayload = vi.fn();
const getDecryptedItem = vi.fn();
const saveTextAsConflictCopy = vi.fn();
const replaceConflictCopyContent = vi.fn();
vi.mock("$lib/core/services/item-service", async () => {
    const actual = await vi.importActual<typeof import("$lib/core/services/item-service")>(
        "$lib/core/services/item-service",
    );
    return {
        ...actual,
        ItemService: {
            ...actual.ItemService,
            updateItemPayload: (...args: unknown[]) => updateItemPayload(...args),
            getDecryptedItem: (...args: unknown[]) => getDecryptedItem(...args),
            saveTextAsConflictCopy: (...args: unknown[]) => saveTextAsConflictCopy(...args),
        },
    };
});

// The cross-tab reconcile runs the SAME strip transform as the tab that stripped (cleanup.ts). A
// deterministic stand-in here — the test is about NoteAutosave's decision, not about DOMPurify.
vi.mock("$lib/modules/files/cleanup", () => ({
    stripFileRefsFromHtml: (html: string, ids: string[]) => {
        let out = html;
        for (const id of ids) out = out.replaceAll(`<p><img data-file-id="${id}"></p>`, "");
        return { html: out, changed: out !== html };
    },
}));

vi.mock("$lib/core/sync/conflict", () => ({
    replaceConflictCopyContent: (...args: unknown[]) => replaceConflictCopyContent(...args),
}));

vi.mock("$lib/core/sync/history", () => ({
    maybeCreateSnapshot: vi.fn(() => Promise.resolve()),
}));

vi.mock("$lib/modules/files/pending-trash", () => ({
    pendingTrashManager: { pendingFileIds: [] as string[] },
}));

const { inFlightPromoteCount, restoreInFlightDataUrls, isVaultSessionCurrent, toastAdd } =
    vi.hoisted(() => ({
        inFlightPromoteCount: vi.fn(() => 0),
        restoreInFlightDataUrls: vi.fn((html: string) => html),
        // True by default (a normal session) — one test below overrides it to
        // false to prove the clear message instead of a silent console.error / AEAD failure.
        isVaultSessionCurrent: vi.fn(() => true),
        toastAdd: vi.fn(),
    }));
vi.mock("$lib/modules/files/promote-inflight", () => ({
    inFlightPromoteCount,
    restoreInFlightDataUrls,
}));
vi.mock("$lib/core/crypto/session-key", () => ({ isVaultSessionCurrent }));
vi.mock("$lib/core/stores/toast.svelte", () => ({ globalToasts: { add: toastAdd } }));

import { APP_EVENTS } from "$lib/core/constants/events";
import { ConcurrentEditConflictError, ItemGoneError } from "$lib/core/services/item-service";
import { syncStore } from "$lib/core/sync/store.svelte";
import { NoteAutosave } from "./NoteAutosave.svelte";

function mockQueryClient(): QueryClient {
    return {
        setQueryData: vi.fn(),
        invalidateQueries: vi.fn(() => Promise.resolve()),
    } as unknown as QueryClient;
}

function makeEditor(html: string): Editor {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return new Editor({
        element: el,
        extensions: [StarterKit],
        content: html,
    });
}

describe("NoteAutosave", () => {
    let editors: Editor[] = [];

    beforeEach(() => {
        updateItemPayload.mockReset();
        updateItemPayload.mockResolvedValue(undefined);
        getDecryptedItem.mockReset();
        inFlightPromoteCount.mockReset();
        inFlightPromoteCount.mockReturnValue(0);
        restoreInFlightDataUrls.mockReset();
        restoreInFlightDataUrls.mockImplementation((html: string) => html);
        isVaultSessionCurrent.mockReset();
        isVaultSessionCurrent.mockReturnValue(true);
        toastAdd.mockReset();
        editors = [];
    });

    afterEach(() => {
        for (const e of editors) e.destroy();
        document.body.innerHTML = "";
    });

    function track(editor: Editor): Editor {
        editors.push(editor);
        return editor;
    }

    it("deriveTitle through executeSave: it uses the first non-empty text", async () => {
        const editor = track(makeEditor("<p>Hello world title</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "note-1",
        );
        autosave.isDirty = true;
        autosave.executeSave("note-1");
        await vi.waitFor(() => expect(updateItemPayload).toHaveBeenCalled());
        const [, title] = updateItemPayload.mock.calls[0]!;
        expect(title).toBe("Hello world title");
    });

    it("deriveTitle: an empty doc → Untitled", async () => {
        const editor = track(makeEditor("<p></p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n1",
        );
        autosave.isDirty = true;
        autosave.executeSave("n1");
        await vi.waitFor(() => expect(updateItemPayload).toHaveBeenCalled());
        expect(updateItemPayload.mock.calls[0]![1]).toBe("Untitled");
    });

    it("basedOnContent reads the baseline for the id being saved, not the current note", async () => {
        const editor = track(makeEditor("<p>body</p>"));
        let current = "note-A";
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => current,
        );
        autosave.setBaseContent("<p>base-A</p>");
        // The switch: current is B, and the flush still saves A with A's baseline
        current = "note-B";
        autosave.isDirty = true;
        autosave.executeSave("note-A");
        await vi.waitFor(() => expect(updateItemPayload).toHaveBeenCalled());
        const opts = updateItemPayload.mock.calls[0]![3] as {
            basedOnContent: () => string | undefined;
        };
        expect(opts.basedOnContent()).toBe("<p>base-A</p>");
    });

    it("ConcurrentEditConflictError clears the baseline and drops dirty for the current note", async () => {
        const editor = track(makeEditor("<p>x</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n1",
        );
        autosave.setBaseContent("<p>old</p>");
        autosave.isDirty = true;
        updateItemPayload.mockRejectedValueOnce(new ConcurrentEditConflictError("n1"));
        autosave.executeSave("n1");
        await vi.waitFor(() => expect(autosave.isDirty).toBe(false));
        // another save with basedOnContent — the map is empty for n1
        updateItemPayload.mockResolvedValueOnce(undefined);
        autosave.isDirty = true;
        autosave.executeSave("n1");
        await vi.waitFor(() => expect(updateItemPayload).toHaveBeenCalledTimes(2));
        const opts = updateItemPayload.mock.calls[1]![3] as {
            basedOnContent: () => string | undefined;
        };
        expect(opts.basedOnContent()).toBeUndefined();
    });

    it("ItemGoneError clears dirty and cancels the autosave loop", async () => {
        const editor = track(makeEditor("<p>x</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n1",
        );
        autosave.isDirty = true;
        updateItemPayload.mockRejectedValueOnce(new ItemGoneError("n1"));
        autosave.executeSave("n1");
        await vi.waitFor(() => expect(autosave.isDirty).toBe(false));
        expect(autosave.isSaving).toBe(false);
    });

    it("mount tells the sync chip about unsaved edits until the save lands", async () => {
        const editor = track(makeEditor("<p>Unsaved</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n-unsaved",
        );
        let finishSave: () => void = () => {};
        updateItemPayload.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishSave = resolve;
                }),
        );

        const unmount = autosave.mount();
        expect(syncStore.hasUnsavedEdits).toBe(false);

        autosave.markDirty();
        expect(syncStore.hasUnsavedEdits).toBe(true);

        // Encrypting and writing to IndexedDB — still not saved.
        autosave.executeSave("n-unsaved");
        expect(autosave.isDirty).toBe(true);
        expect(syncStore.hasUnsavedEdits).toBe(true);

        finishSave();
        await vi.waitFor(() => expect(autosave.isSaving).toBe(false));
        expect(syncStore.hasUnsavedEdits).toBe(false);

        // Unmounting a note that is still dirty removes the source with it.
        autosave.markDirty();
        expect(syncStore.hasUnsavedEdits).toBe(true);
        unmount();
        autosave.cancelAutosave();
        expect(syncStore.hasUnsavedEdits).toBe(false);
    });

    it("a note switch keeps the chip on unsaved while the old note's flush is still writing", async () => {
        const editor = track(makeEditor("<p>Old note</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n-new",
        );
        let finishSave: () => void = () => {};
        updateItemPayload.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishSave = resolve;
                }),
        );
        const unmount = autosave.mount();
        autosave.markDirty();

        // The switch resets isDirty for the new note; the old note is not in IndexedDB yet.
        autosave.onNoteSwitch("n-old");
        expect(autosave.isDirty).toBe(false);
        expect(syncStore.hasUnsavedEdits).toBe(true);

        finishSave();
        await vi.waitFor(() => expect(syncStore.hasUnsavedEdits).toBe(false));
        unmount();
    });

    it("mount registers visibilitychange and pagehide listeners to save dirty note on hidden/pagehide", async () => {
        const editor = track(makeEditor("<p>Visibility test</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n-vis",
        );
        const unmount = autosave.mount();
        autosave.isDirty = true;

        // Dispatch visibilitychange hidden
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        window.dispatchEvent(new Event("visibilitychange"));

        await vi.waitFor(() => expect(updateItemPayload).toHaveBeenCalled());
        expect(updateItemPayload.mock.calls[0]![0]).toBe("n-vis");

        unmount();
    });

    it("onNoteSwitch preserves isDirty when pending trash prevents executeSave", async () => {
        const { pendingTrashManager } = await import("$lib/modules/files/pending-trash");
        const spy = vi
            .spyOn(pendingTrashManager, "pendingFileIds", "get")
            .mockReturnValue(["file-1"]);

        const editor = track(makeEditor("<p>Pending trash test</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "note-A",
        );
        autosave.isDirty = true;

        autosave.onNoteSwitch("note-A");

        expect(autosave.isDirty).toBe(true);
        spy.mockRestore();
    });

    it("defers the save while inFlightPromoteCount > 0", () => {
        inFlightPromoteCount.mockReturnValue(1);
        const editor = track(makeEditor("<p>staging</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n-stage",
        );
        autosave.isDirty = true;
        const started = autosave.executeSave("n-stage", { forced: false });
        expect(started).toBe(false);
        expect(updateItemPayload).not.toHaveBeenCalled();
        expect(autosave.isDirty).toBe(true);
        inFlightPromoteCount.mockReturnValue(0);
    });

    // A clear message and a stopped loop instead of a silent console.error/AEAD failure.
    it("refuses to save and reports clearly once the session is no longer valid", () => {
        isVaultSessionCurrent.mockReturnValue(false);
        const editor = track(makeEditor("<p>stale tab</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n-stale",
        );
        autosave.isDirty = true;

        const started = autosave.executeSave("n-stale");

        expect(started).toBe(false);
        expect(updateItemPayload).not.toHaveBeenCalled();
        expect(autosave.isDirty).toBe(false);
        expect(toastAdd).toHaveBeenCalledWith(
            expect.objectContaining({
                variant: "error",
                message: expect.stringContaining("signed out"),
            }),
        );
    });

    it("a forced flush restores data: in the middle of staging", async () => {
        inFlightPromoteCount.mockReturnValue(1);
        restoreInFlightDataUrls.mockReturnValue(
            '<p>keep</p><img src="data:image/png;base64,AA" />',
        );
        const editor = track(makeEditor("<p>keep</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n-force",
        );
        autosave.isDirty = true;
        const started = autosave.executeSave("n-force", { forced: true });
        expect(started).toBe(true);
        expect(restoreInFlightDataUrls).toHaveBeenCalled();
        await vi.waitFor(() => expect(updateItemPayload).toHaveBeenCalled());
        const savedHtml = updateItemPayload.mock.calls[0]![2] as string;
        expect(savedHtml).toContain("data:image/png");
        expect(savedHtml).not.toContain("local:x");
    });

    // ── Cross-tab file refs (APP_EVENTS.remoteFileRefsChanged) ─────────────────────────────────
    describe("another tab trashed / moved / restored a file", () => {
        const BASE = '<p>text</p><p><img data-file-id="f1"></p>';
        const STRIPPED = "<p>text</p>";

        function remote(detail: { fileId: string; toNoteId?: string }) {
            window.dispatchEvent(new CustomEvent(APP_EVENTS.remoteFileRefsChanged, { detail }));
        }

        async function baselineOf(autosave: NoteAutosave, id: string): Promise<string | undefined> {
            autosave.isDirty = true;
            autosave.executeSave(id);
            await vi.waitFor(() => expect(updateItemPayload).toHaveBeenCalled());
            const opts = updateItemPayload.mock.calls[0]![3] as {
                basedOnContent: () => string | undefined;
            };
            return opts.basedOnContent();
        }

        it("mid-edit + the file was trashed: IDB equals baseline-minus-embed → the baseline moves, no conflict", async () => {
            const editor = track(makeEditor("<p>text</p>"));
            const autosave = new NoteAutosave(
                mockQueryClient(),
                () => editor,
                () => "n1",
            );
            const unmount = autosave.mount();
            autosave.setBaseContent(BASE);
            autosave.isDirty = true;
            getDecryptedItem.mockResolvedValue({ payload: { content: STRIPPED } });

            remote({ fileId: "f1" });
            await vi.waitFor(() => expect(getDecryptedItem).toHaveBeenCalledWith("n1"));
            await new Promise((r) => setTimeout(r, 0));

            expect(await baselineOf(autosave, "n1")).toBe(STRIPPED);
            unmount();
        });

        it("mid-edit + IDB differs by more than the strip: the baseline stays (a genuine conflict later)", async () => {
            const editor = track(makeEditor("<p>text</p>"));
            const autosave = new NoteAutosave(
                mockQueryClient(),
                () => editor,
                () => "n1",
            );
            const unmount = autosave.mount();
            autosave.setBaseContent(BASE);
            autosave.isDirty = true;
            getDecryptedItem.mockResolvedValue({ payload: { content: "<p>other tab typed</p>" } });

            remote({ fileId: "f1" });
            await vi.waitFor(() => expect(getDecryptedItem).toHaveBeenCalled());
            await new Promise((r) => setTimeout(r, 0));

            expect(await baselineOf(autosave, "n1")).toBe(BASE);
            unmount();
        });

        it("a clean editor → a force reload is requested instead of touching the baseline", async () => {
            const editor = track(makeEditor("<p>text</p>"));
            const autosave = new NoteAutosave(
                mockQueryClient(),
                () => editor,
                () => "n1",
            );
            const unmount = autosave.mount();
            autosave.setBaseContent(BASE);
            autosave.isDirty = false;
            const reloads: string[] = [];
            const onReload = (e: Event) =>
                reloads.push((e as CustomEvent<{ noteId: string }>).detail.noteId);
            window.addEventListener(APP_EVENTS.noteForceReload, onReload);

            remote({ fileId: "f1" });
            await vi.waitFor(() => expect(reloads).toEqual(["n1"]));

            expect(getDecryptedItem).not.toHaveBeenCalled();
            window.removeEventListener(APP_EVENTS.noteForceReload, onReload);
            unmount();
        });

        it("a note that never embedded the file is left alone", async () => {
            const editor = track(makeEditor("<p>text</p>"));
            const autosave = new NoteAutosave(
                mockQueryClient(),
                () => editor,
                () => "n1",
            );
            const unmount = autosave.mount();
            autosave.setBaseContent("<p>text</p>");
            autosave.isDirty = true;

            remote({ fileId: "f9" });
            await new Promise((r) => setTimeout(r, 0));

            expect(getDecryptedItem).not.toHaveBeenCalled();
            expect(await baselineOf(autosave, "n1")).toBe("<p>text</p>");
            unmount();
        });

        it("the destination of a move mid-edit: exactly one appended embed paragraph moves the baseline", async () => {
            const editor = track(makeEditor("<p>text</p>"));
            const autosave = new NoteAutosave(
                mockQueryClient(),
                () => editor,
                () => "dest",
            );
            const unmount = autosave.mount();
            autosave.setBaseContent("<p>text</p>");
            autosave.isDirty = true;
            const appended =
                '<p>text</p><p><img data-file-id="f2" alt="pic.png" data-mime="image/png"></img></p>';
            getDecryptedItem.mockResolvedValue({ payload: { content: appended } });

            remote({ fileId: "f2", toNoteId: "dest" });
            await vi.waitFor(() => expect(getDecryptedItem).toHaveBeenCalledWith("dest"));
            await new Promise((r) => setTimeout(r, 0));

            expect(await baselineOf(autosave, "dest")).toBe(appended);
            unmount();
        });
    });

    it("beforeunload starts a forced save while the browser shows its prompt", async () => {
        const editor = track(makeEditor("<p>unsaved typing</p>"));
        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => editor,
            () => "n1",
        );
        const unmount = autosave.mount();
        autosave.isDirty = true;

        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);

        expect(e.defaultPrevented).toBe(true); // the prompt still shows
        await vi.waitFor(() => expect(updateItemPayload).toHaveBeenCalledTimes(1)); // and the save is under way
        unmount();
    });

    // ── The idle debounce and its cap (fake timers; a plain editor stub, no TipTap) ─────────────
    describe("autosave timing", () => {
        function editorStub(text: string): Editor {
            return {
                isDestroyed: false,
                getHTML: () => `<p>${text}</p>`,
                state: {
                    doc: {
                        descendants: (cb: (node: unknown) => boolean | void) => {
                            cb({ isText: true, text });
                        },
                    },
                },
            } as unknown as Editor;
        }

        it("saves 10 s after the LAST keystroke — a keystroke inside the window restarts the debounce", () => {
            vi.useFakeTimers();
            try {
                const autosave = new NoteAutosave(
                    mockQueryClient(),
                    () => editorStub("typing"),
                    () => "n1",
                );
                autosave.markDirty();
                vi.advanceTimersByTime(8_000);
                autosave.markDirty(); // 8 s in — the window restarts
                vi.advanceTimersByTime(8_000); // 16 s since the first keystroke, 8 s since the last
                expect(updateItemPayload).not.toHaveBeenCalled();

                vi.advanceTimersByTime(2_500); // 10 s of silence
                expect(updateItemPayload).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it("continuous typing still saves at the 2-minute cap", () => {
            vi.useFakeTimers();
            try {
                const autosave = new NoteAutosave(
                    mockQueryClient(),
                    () => editorStub("typing"),
                    () => "n1",
                );
                // A keystroke every 5 s never leaves a 10 s gap; the cap has to fire anyway.
                for (let t = 0; t < 2 * 60 * 1000; t += 5_000) {
                    autosave.markDirty();
                    vi.advanceTimersByTime(5_000);
                }
                expect(updateItemPayload).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});

describe("NoteAutosave — a push 409 while the note is open", () => {
    let editors: Editor[] = [];
    let unmount: (() => void) | undefined;
    let reloads: string[] = [];
    const onReload = (e: Event) =>
        reloads.push((e as CustomEvent<{ noteId: string }>).detail.noteId);

    beforeEach(() => {
        updateItemPayload.mockReset();
        updateItemPayload.mockResolvedValue(undefined);
        replaceConflictCopyContent.mockReset();
        replaceConflictCopyContent.mockResolvedValue("written");
        saveTextAsConflictCopy.mockReset();
        saveTextAsConflictCopy.mockResolvedValue(undefined);
        inFlightPromoteCount.mockReturnValue(0);
        isVaultSessionCurrent.mockReturnValue(true);
        toastAdd.mockReset();
        editors = [];
        reloads = [];
        window.addEventListener(APP_EVENTS.noteForceReload, onReload);
    });

    afterEach(() => {
        unmount?.();
        unmount = undefined;
        window.removeEventListener(APP_EVENTS.noteForceReload, onReload);
        for (const e of editors) e.destroy();
        document.body.innerHTML = "";
    });

    function open(
        html: string,
        noteId = "n1",
    ): { autosave: NoteAutosave; editor: Editor; queryClient: QueryClient } {
        const editor = makeEditor(html);
        editors.push(editor);
        const queryClient = mockQueryClient();
        const autosave = new NoteAutosave(
            queryClient,
            () => editor,
            () => noteId,
        );
        unmount = autosave.mount();
        return { autosave, editor, queryClient };
    }

    function push409(noteId = "n1") {
        window.dispatchEvent(
            new CustomEvent(APP_EVENTS.notePushConflict, {
                detail: { noteId, copyId: "copy-1", copyTitle: "N [Conflict 2026-09-29 10:00]" },
            }),
        );
    }

    it("unsaved text goes into THE copy, then the editor reloads with a toast naming it", async () => {
        const { autosave } = open("<p>saved and typed</p>");
        autosave.isDirty = true;

        push409();

        await vi.waitFor(() => expect(reloads).toEqual(["n1"]));
        expect(replaceConflictCopyContent).toHaveBeenCalledWith(
            "copy-1",
            "n1",
            "saved and typed",
            "<p>saved and typed</p>",
        );
        expect(updateItemPayload).not.toHaveBeenCalled(); // no save of its own → no second copy
        expect(saveTextAsConflictCopy).not.toHaveBeenCalled();
        expect(toastAdd).toHaveBeenCalledTimes(1);
        expect(toastAdd.mock.calls[0]?.[0].message).toContain("N [Conflict 2026-09-29 10:00]");
    });

    it("with nothing unsaved it still reloads and says where the version went", async () => {
        const { autosave } = open("<p>saved</p>");
        autosave.isDirty = false;
        replaceConflictCopyContent.mockResolvedValue("unchanged");

        push409();

        await vi.waitFor(() => expect(reloads).toEqual(["n1"]));
        expect(toastAdd).toHaveBeenCalledTimes(1);
    });

    it("a save already in flight lands in the copy; the settle waits for it, then adds what came after", async () => {
        const { autosave, editor, queryClient } = open("<p>first</p>");
        autosave.isDirty = true;
        let rejectSave: (e: unknown) => void = () => {};
        updateItemPayload.mockImplementationOnce(
            () =>
                new Promise((_, reject) => {
                    rejectSave = reject;
                }),
        );
        autosave.executeSave("n1");
        await vi.waitFor(() => expect(updateItemPayload).toHaveBeenCalledTimes(1));

        push409();
        // The save meets the conflict now: it is handed this editor's copy, not a new one.
        const opts = updateItemPayload.mock.calls[0]?.[3] as {
            intoConflictCopy: () => string | undefined;
        };
        expect(opts.intoConflictCopy()).toBe("copy-1");
        // Typed while that save was in flight.
        editor.commands.setContent("<p>first and more</p>");
        await Promise.resolve();
        expect(replaceConflictCopyContent).not.toHaveBeenCalled(); // still waiting for the save

        rejectSave(new ConcurrentEditConflictError("n1"));

        await vi.waitFor(() => expect(reloads).toEqual(["n1"]));
        expect(replaceConflictCopyContent).toHaveBeenCalledTimes(1);
        expect(replaceConflictCopyContent.mock.calls[0]?.[3]).toBe("<p>first and more</p>");
        expect(updateItemPayload).toHaveBeenCalledTimes(1);
        // The routed save left the editor alone: a refetch of the note there would have loaded the
        // server version over "and more" before the settle read it.
        expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
        expect(saveTextAsConflictCopy).not.toHaveBeenCalled();
    });

    it("no new save of that note starts while the copy is being settled", async () => {
        const { autosave } = open("<p>typed</p>");
        autosave.isDirty = true;
        let finish: (v: "written") => void = () => {};
        replaceConflictCopyContent.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );

        push409();
        await vi.waitFor(() => expect(replaceConflictCopyContent).toHaveBeenCalled());
        expect(autosave.executeSave("n1")).toBe(false);
        finish("written");

        await vi.waitFor(() => expect(reloads).toEqual(["n1"]));
        expect(updateItemPayload).not.toHaveBeenCalled();
    });

    it("a 409 for a note that is not open is left to the note's next load", async () => {
        const { autosave } = open("<p>typed</p>", "n1");
        autosave.isDirty = true;

        push409("other-note");
        await new Promise((r) => setTimeout(r, 0));

        expect(replaceConflictCopyContent).not.toHaveBeenCalled();
        expect(reloads).toEqual([]);
        expect(toastAdd).not.toHaveBeenCalled();
    });

    it("the copy is gone → the text is kept as a new copy (that path brings its own toast)", async () => {
        const { autosave } = open("<p>typed</p>");
        autosave.isDirty = true;
        replaceConflictCopyContent.mockResolvedValue("unavailable");

        push409();

        await vi.waitFor(() =>
            expect(saveTextAsConflictCopy).toHaveBeenCalledWith("n1", "typed", "<p>typed</p>"),
        );
        expect(toastAdd).not.toHaveBeenCalled();
        expect(reloads).toEqual([]);
    });

    it("writing the copy fails → no reload over the text, and the editor stays dirty", async () => {
        const { autosave } = open("<p>typed</p>");
        autosave.isDirty = false;
        replaceConflictCopyContent.mockRejectedValue(new Error("worker gone"));
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            push409();
            await vi.waitFor(() => expect(autosave.isDirty).toBe(true));
            expect(reloads).toEqual([]);
            // The next save may start again (not blocked by the settle any more).
            expect(autosave.executeSave("n1")).toBe(true);
        } finally {
            consoleError.mockRestore();
        }
    });
});
