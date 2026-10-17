import type { QueryClient } from "@tanstack/svelte-query";
import type { Editor } from "@tiptap/core";
import { APP_EVENTS } from "$lib/core/constants/events";
import { QUERY_KEYS } from "$lib/core/constants/query-keys";
import { isVaultSessionCurrent } from "$lib/core/crypto/session-key";
import {
    ConcurrentEditConflictError,
    ItemGoneError,
    ItemService,
} from "$lib/core/services/item-service";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { replaceConflictCopyContent } from "$lib/core/sync/conflict";
import { maybeCreateSnapshot } from "$lib/core/sync/history";
import { syncStore } from "$lib/core/sync/store.svelte";
import { MINUTE_MS, SECOND_MS } from "$lib/core/utils/duration";
// modules/notes → modules/files: the same precedent as pending-trash.
import { pendingTrashManager } from "$lib/modules/files/pending-trash";
import { inFlightPromoteCount, restoreInFlightDataUrls } from "$lib/modules/files/promote-inflight";

/**
 * Idle debounce: a save runs this long after the LAST keystroke. Two minutes of silence used to be
 * the only trigger, and the pagehide save cannot finish its worker round trips once the document is
 * going away — up to two minutes of typing was lost on a tab close.
 */
const AUTOSAVE_IDLE_MS = 10 * SECOND_MS;
/** The upper bound: continuous typing still saves at least this often (measured from the first unsaved keystroke). */
const AUTOSAVE_MAX_MS = 2 * MINUTE_MS;

/**
 * Is `tail` exactly the one embed paragraph `ItemService.appendFileToNote` produces for `fileId`
 * (`<p><img data-file-id="…" alt="…" …></img></p>`)? Used by the cross-tab destination reconcile.
 */
function isSingleEmbedParagraph(tail: string, fileId: string): boolean {
    const id = fileId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^<p><img [^>]*\\bdata-file-id="${id}"[^>]*>(?:</img>)?</p>$`).test(tail);
}

export class NoteAutosave {
    isDirty = $state(false);
    isSaving = $state(false);
    /**
     * The HTML content of the last successful local save — the note page recognises its own write on
     * a refetch, even when a push has bumped `version` meanwhile, and does not treat it as
     * "Updated from another device".
     */
    lastSavedContent = $state<string | null>(null);
    /**
     * A multi-tab baseline per note id (rather than one global string).
     *
     * Why a map: on a switch, `currentNoteId` and the new note's load happen BEFORE the old note's
     * flush-save enters the write lock. A single `#baseContent` would then be nulled or overwritten
     * with the NEW note's content → the multi-tab check compares the wrong baseline and sees a false
     * conflict ("updated elsewhere" after merely deleting text and clicking another note).
     *
     * The getter in updateItemPayload reads the baseline for the id being saved; a same-tab write (a
     * file-ref strip) moves only that id in the map.
     */
    #baseByNoteId = new Map<string, string>();
    /**
     * The conflict copy a push 409 made from this editor, per note id, for as long as the
     * editor is settling it (#settlePushConflict). A save that meets the conflict meanwhile writes into
     * this copy instead of a second one; a new save of that note does not start at all.
     */
    #pushConflictCopyByNote = new Map<string, string>();
    /** The save in flight, so the push-conflict settle can wait for it before it reads the editor. */
    #inFlightSave: Promise<void> | null = null;
    #saveTimeout: ReturnType<typeof setTimeout> | undefined;
    /** When the current run of unsaved keystrokes began — the anchor for AUTOSAVE_MAX_MS. */
    #dirtySince: number | null = null;

    constructor(
        private queryClient: QueryClient,
        private getEditor: () => Editor | undefined,
        private getCurrentNoteId: () => string | undefined,
    ) {}

    /** Sets the baseline content for the note currently open (a first load, or an external update). */
    setBaseContent(html: string): void {
        const id = this.getCurrentNoteId();
        if (id) this.#baseByNoteId.set(id, html);
    }

    /**
     * A same-tab IDB write (a file-ref strip, an append, another save) — move the baseline for THAT
     * note id. It does not depend on getCurrentNoteId(): the old note's flush save after a switch has to see the strip
     * on the old id. Events from another tab still do not arrive (this is per-window).
     */
    #onNoteContentWritten = (e: Event): void => {
        const { noteId, content } =
            (e as CustomEvent<{ noteId?: string; content?: string }>).detail ?? {};
        if (!noteId || typeof content !== "string") return;
        this.#baseByNoteId.set(noteId, content);
    };

    /**
     * ANOTHER TAB trashed, moved or restored a file (APP_EVENTS.remoteFileRefsChanged) and rewrote
     * this note's stored content — an embed stripped, or one appended. The baseline of this tab is
     * per-window, so without a reconcile the next save here would see IDB ≠ baseline ≠ editor and
     * park the user's typing in a false "updated elsewhere" conflict copy.
     *
     * `isDirty` is captured synchronously: the receiver dispatches this event BEFORE it removes the
     * encFile node from this editor, and that removal itself marks the doc dirty.
     */
    #onRemoteFileRefsChanged = (e: Event): void => {
        const { fileId, toNoteId } =
            (e as CustomEvent<{ fileId?: string; toNoteId?: string }>).detail ?? {};
        if (!fileId) return;
        const id = this.getCurrentNoteId();
        if (!id) return;
        void this.#reconcileRemoteFileRefs(id, fileId, toNoteId, this.isDirty);
    };

    async #reconcileRemoteFileRefs(
        noteId: string,
        fileId: string,
        toNoteId: string | undefined,
        wasDirty: boolean,
    ): Promise<void> {
        const isDestination = toNoteId === noteId;
        const base = this.#baseByNoteId.get(noteId);
        if (!isDestination && !base?.includes(`data-file-id="${fileId}"`)) return; // not our embed

        if (!wasDirty) {
            // Nothing of the user's to protect — take the other tab's content (the reload sets the
            // baseline and clears dirty).
            if (typeof window !== "undefined") {
                window.dispatchEvent(
                    new CustomEvent(APP_EVENTS.noteForceReload, { detail: { noteId } }),
                );
            }
            return;
        }
        if (base === undefined) return;

        // Mid-edit: never reload over the user's typing. Move the baseline ONLY when IDB provably
        // holds "baseline minus/plus exactly this file's embed" — anything else is a genuine
        // divergence (the other tab also edited text) and stays a conflict, as it should.
        let stored: unknown;
        try {
            const note = await ItemService.getDecryptedItem(noteId);
            stored = note?.payload?.content;
        } catch {
            return;
        }
        if (typeof stored !== "string") return;

        if (isDestination) {
            // appendFileToNote appends exactly one embed paragraph to the stored content.
            if (!stored.startsWith(base)) return;
            const tail = stored.slice(base.length);
            if (!isSingleEmbedParagraph(tail, fileId)) return;
            this.#baseByNoteId.set(noteId, stored);
            const editor = this.getEditor();
            if (editor && !editor.isDestroyed) {
                editor.chain().insertContentAt(editor.state.doc.content.size, tail).run();
            }
            return;
        }

        // The SAME transform the other tab ran (cleanup.ts) — deterministic, so string equality is
        // the proof. modules/notes → modules/files: the precedent of pending-trash.
        const { stripFileRefsFromHtml } = await import("$lib/modules/files/cleanup");
        const expected = stripFileRefsFromHtml(base, [fileId]).html;
        if (expected !== stored) return;
        this.#baseByNoteId.set(noteId, stored);
    }

    /**
     * A push of a note came back 409 (APP_EVENTS.notePushConflict): IDB now holds the other device's
     * version and a conflict copy holds this tab's last saved one. Only the open note matters here —
     * a note opened later loads the server version from IDB anyway.
     */
    #onNotePushConflict = (e: Event): void => {
        const { noteId, copyId, copyTitle } =
            (e as CustomEvent<{ noteId?: string; copyId?: string; copyTitle?: string }>).detail ??
            {};
        if (!noteId || !copyId || noteId !== this.getCurrentNoteId()) return;
        void this.#settlePushConflict(noteId, copyId, copyTitle || "a conflict copy");
    };

    /**
     * One conflict = one copy. Everything the editor holds that
     * the copy does not goes into THAT copy; only then does the editor reload to the server version,
     * with a toast naming the copy. Without this the editor kept the user's text, and its next save
     * made a second copy — the first one never announced.
     */
    async #settlePushConflict(noteId: string, copyId: string, copyTitle: string): Promise<void> {
        this.#pushConflictCopyByNote.set(noteId, copyId);
        this.cancelAutosave();
        try {
            // A save that was already running lands in the same copy (the getter in #performSave);
            // wait for it, so what it wrote is not overwritten with an older read of the editor.
            if (this.#inFlightSave) await this.#inFlightSave;
            // Text typed while the copy is being encrypted goes in too — re-read until it holds still.
            for (let pass = 0; pass < 5; pass++) {
                const editor = this.getEditor();
                if (!editor || editor.isDestroyed || this.getCurrentNoteId() !== noteId) break;
                const html = editor.getHTML();
                const title = this.#deriveTitle(editor);
                const written = await replaceConflictCopyContent(copyId, noteId, title, html);
                if (written === "unavailable") {
                    // The copy was resolved or removed meanwhile: keep the text as a new copy (that
                    // path brings its own toast and reload).
                    await ItemService.saveTextAsConflictCopy(noteId, title, html);
                    return;
                }
                if (editor.isDestroyed || editor.getHTML() === html) break;
            }
        } catch (e) {
            // No reload: the editor keeps the text, and the note stays dirty so it is not lost.
            console.error("Failed to move unsaved text into the conflict copy", e);
            this.isDirty = true;
            return;
        } finally {
            this.#pushConflictCopyByNote.delete(noteId);
        }
        if (this.getCurrentNoteId() !== noteId) return;
        globalToasts.add({
            variant: "info",
            message: `This note was changed on another device. Your version is saved as "${copyTitle}" — open Conflict Inbox to choose.`,
        });
        if (typeof window !== "undefined") {
            window.dispatchEvent(
                new CustomEvent(APP_EVENTS.noteForceReload, { detail: { noteId } }),
            );
        }
    }

    // Called from TipTap's onUpdate (only while isProgrammaticUpdate is false).
    markDirty(): void {
        // Do NOT write an IDB dirty on the first keystroke — a phantom dirty with no new ciphertext and no queue entry
        // blocks the pull forever (the engine skips anything dirty) while pendingCount stays 0.
        // Pull protection: basedOnContent in updateItemPayload + isDirty in the editor (a forced reload
        // does not overwrite a dirty editor). An IDB dirty comes only on a real save.
        this.isDirty = true;
        const now = Date.now();
        if (this.#dirtySince === null) this.#dirtySince = now;
        // An idle debounce restarted on every keystroke, capped so a run of continuous typing still
        // saves within AUTOSAVE_MAX_MS of its first keystroke.
        const untilCap = Math.max(0, this.#dirtySince + AUTOSAVE_MAX_MS - now);
        clearTimeout(this.#saveTimeout);
        this.#saveTimeout = setTimeout(
            () => {
                this.#saveTimeout = undefined;
                if (!this.isDirty) return;
                const id = this.getCurrentNoteId();
                if (id) this.executeSave(id, { forced: false });
            },
            Math.min(AUTOSAVE_IDLE_MS, untilCap),
        );
    }

    cancelAutosave(): void {
        clearTimeout(this.#saveTimeout);
        this.#saveTimeout = undefined;
    }

    // Flushes unsaved changes synchronously (reading the HTML before the editor tears down).
    // Safe to call even when nothing is dirty. Returns true if a save was started.
    // forced: true — pagehide / visibility / note-switch (restore in-flight data:).
    flush(id: string): boolean {
        const editor = this.getEditor();
        if (editor && !editor.isDestroyed) {
            if (this.isDirty) return this.executeSave(id, { forced: true });
        }
        return false;
    }

    // Called when the note changes: flush the previous note, snapshot it, then reset the UI state.
    // The old note's baseline STAYS in the map until the flush-save finishes (see #performSave).
    onNoteSwitch(prevNoteId: string): void {
        const executed = this.flush(prevNoteId);
        // Fire-and-forget: the snapshot is best-effort and never blocks navigation
        void maybeCreateSnapshot(prevNoteId).catch(() => {});
        if (executed || pendingTrashManager.pendingFileIds.length === 0) {
            this.isDirty = false;
        }
        this.lastSavedContent = null;
        this.cancelAutosave();
    }

    handleKeyDown(e: KeyboardEvent): void {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            if (this.isDirty) {
                const id = this.getCurrentNoteId();
                // Ctrl+S is not forced — if staging is running, defer (the user can try again).
                if (id) this.executeSave(id, { forced: false });
            }
        }
    }

    // Called from the component's mount to register beforeunload, visibilitychange, pagehide + the same-tab content baseline.
    // It also tells the sync chip about unsaved edits: the store reads this getter, so isDirty and
    // isSaving stay the one source of truth.
    mount(): () => void {
        const unregisterUnsaved = syncStore.registerUnsavedEdits(
            () => this.isDirty || this.isSaving,
        );
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (this.isDirty) {
                // Start the save NOW, not on pagehide: the document stays alive while the browser
                // shows its "Leave site?" prompt, and that dwell time is exactly what the async worker
                // round trips (decrypt, encrypt, IDB put) need. A save started on pagehide is torn
                // down with the document and never lands.
                const id = this.getCurrentNoteId();
                if (id) void this.executeSave(id, { forced: true });
                e.preventDefault();
                e.returnValue = "You have unsaved changes.";
            }
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === "hidden" && this.isDirty) {
                const id = this.getCurrentNoteId();
                if (id) void this.executeSave(id, { forced: true });
            }
        };
        const onPageHide = () => {
            if (this.isDirty) {
                const id = this.getCurrentNoteId();
                if (id) void this.executeSave(id, { forced: true });
            }
        };

        window.addEventListener("beforeunload", onBeforeUnload);
        window.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener(APP_EVENTS.noteContentWritten, this.#onNoteContentWritten);
        window.addEventListener(APP_EVENTS.remoteFileRefsChanged, this.#onRemoteFileRefsChanged);
        window.addEventListener(APP_EVENTS.notePushConflict, this.#onNotePushConflict);

        return () => {
            unregisterUnsaved();
            window.removeEventListener("beforeunload", onBeforeUnload);
            window.removeEventListener("visibilitychange", onVisibilityChange);
            window.removeEventListener("pagehide", onPageHide);
            window.removeEventListener(APP_EVENTS.noteContentWritten, this.#onNoteContentWritten);
            window.removeEventListener(
                APP_EVENTS.remoteFileRefsChanged,
                this.#onRemoteFileRefsChanged,
            );
            window.removeEventListener(APP_EVENTS.notePushConflict, this.#onNotePushConflict);
        };
    }

    /**
     * Reads the HTML from the editor synchronously, before TipTap can be destroyed, then starts an
     * async save in the background. Returns true if a save was started.
     *
     * @param opts.forced — pagehide, visibility or a note switch: do not defer for promote staging;
     *   instead restore `data:` for jobs still in flight.
     */
    executeSave(id: string, opts?: { forced?: boolean }): boolean {
        if (pendingTrashManager.pendingFileIds.length > 0) return false;
        // The push-conflict settle is reading the editor into the copy; it reloads when done.
        if (this.#pushConflictCopyByNote.has(id)) return false;
        if (!isVaultSessionCurrent()) {
            // Another user has signed in to this browser and the session
            // the generation has rotated — this tab may no longer save. Without this check, in the
            // SharedWorker topology the user would wait on a silent AEAD failure (item-service.ts
            // "Item cannot be decrypted" → console.error); here we report it clearly and at once, and
            // we stop the autosave loop rather than let it keep trying every 2 minutes.
            globalToasts.add({
                variant: "error",
                message:
                    "You've been signed out because a different account was logged in on this browser — this note can no longer be saved here.",
            });
            this.isDirty = false;
            this.cancelAutosave();
            return false;
        }
        const editor = this.getEditor();
        if (!editor || editor.isDestroyed) return false;

        const forced = opts?.forced === true;
        const inflight = inFlightPromoteCount(id);
        if (!forced && inflight > 0) {
            // Deferred: keep it dirty and retry shortly once staging finishes, rather than waiting for the 2-minute autosave.
            if (!this.#saveTimeout) {
                this.#saveTimeout = setTimeout(() => {
                    this.#saveTimeout = undefined;
                    if (!this.isDirty) return;
                    const cur = this.getCurrentNoteId();
                    if (cur) this.executeSave(cur, { forced: false });
                }, 500);
            }
            return false;
        }

        let html = editor.getHTML();
        if (forced && inflight > 0) {
            html = restoreInFlightDataUrls(html, id);
        }
        const title = this.#deriveTitle(editor);

        // An optimistic cache update: it prevents navigation returning stale data while
        // an async save is in flight.
        this.queryClient.setQueryData(
            QUERY_KEYS.note(id),
            (old: Awaited<ReturnType<typeof ItemService.getDecryptedItem>>) => {
                if (!old) return old;
                return {
                    ...old,
                    payload: { ...old.payload, contentTitle: title, content: html },
                };
            },
        );

        // basedOnContent is read inside the item write lock, from the map entry for THIS id — not
        // from the "current" note, which on a switch already points at the next one.
        const save = this.#performSave(id, title, html);
        this.#inFlightSave = save;
        void save.finally(() => {
            if (this.#inFlightSave === save) this.#inFlightSave = null;
        });
        return true;
    }

    async #performSave(idToSave: string, title: string, html: string): Promise<void> {
        this.cancelAutosave();
        // The run of unsaved keystrokes is being written — the next keystroke starts a new run.
        this.#dirtySince = null;
        this.isSaving = true;
        try {
            await ItemService.updateItemPayload(idToSave, title, html, {
                basedOnContent: () => this.#baseByNoteId.get(idToSave),
                intoConflictCopy: () => this.#pushConflictCopyByNote.get(idToSave),
            });
            // The baseline for the saved note is the HTML just written, even when it is no longer the
            // current one — otherwise the next open would use a stale base from the map before its
            // load.
            this.#baseByNoteId.set(idToSave, html);
            // Clear dirty and record the ack only if the user has not moved to another note meanwhile.
            if (idToSave === this.getCurrentNoteId()) {
                this.isDirty = false;
                // The content, not the version — a push after the save increments the version before the note refetches.
                this.lastSavedContent = html;
            } else {
                // A flush after a switch — the baseline is no longer needed (the next open sets a new one).
                this.#baseByNoteId.delete(idToSave);
            }
            await this.queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
            await this.queryClient.invalidateQueries({ queryKey: QUERY_KEYS.note(idToSave) });
        } catch (e) {
            if (e instanceof ConcurrentEditConflictError) {
                // Went into the copy of a push 409 that #settlePushConflict is settling: the editor is
                // left alone (a refetch here would load the server version over text the settle has
                // yet to read), and the settle does the reload.
                if (this.#pushConflictCopyByNote.has(idToSave)) return;
                // Our changes are in the conflict copy; the original is untouched. noteForceReload pulls from IDB.
                this.#baseByNoteId.delete(idToSave);
                if (idToSave === this.getCurrentNoteId()) {
                    this.isDirty = false;
                    this.lastSavedContent = null;
                    this.cancelAutosave();
                }
                await this.queryClient.invalidateQueries({ queryKey: QUERY_KEYS.treeItems });
                await this.queryClient.invalidateQueries({ queryKey: QUERY_KEYS.note(idToSave) });
            } else if (e instanceof ItemGoneError) {
                // The note vanished from under us (deleted or purged on another device). Do not spam the console
                // or retry — tell the user clearly and stop the autosave loop for this note.
                this.#baseByNoteId.delete(idToSave);
                globalToasts.add({
                    variant: "error",
                    message:
                        "This note no longer exists — it may have been deleted on another device.",
                });
                this.isDirty = false;
                this.cancelAutosave();
            } else {
                console.error("Save failed", e);
            }
        } finally {
            this.isSaving = false;
        }
    }

    // Walk the document for the first non-empty TEXT node, skipping atom block nodes such as encFile
    // (whose sort_order UUID would otherwise become the title).
    // IMPORTANT: in ProseMirror a `text` node is `isAtom` too — check isText first, or every piece of
    // text is skipped and the title stays "Untitled" forever.
    #deriveTitle(editor: Editor): string {
        let title = "";
        editor.state.doc.descendants((node) => {
            if (title) return false;
            if (node.isText && node.text?.trim()) {
                title = node.text.trim().substring(0, 50);
                return false;
            }
            // Block atoms (encFile, a horizontal rule, …) — do not descend into their children (there are none).
            if (node.isAtom || node.type.name === "encFile") return false;
        });
        return title || "Untitled";
    }
}
