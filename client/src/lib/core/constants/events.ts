// The custom DOM events' names — the one definition (they used to be magic strings across 15+ files).
// The document-level events are a deliberate bridge between the TipTap NodeView (which lives outside
// the Svelte context) and the Svelte world — see NoteFileEvents.svelte.ts.
export const APP_EVENTS = {
    /** The IDB items changed (a sync pull, a mutation) — the UI has to refetch the tree. */
    vaultItemsChanged: "vault-items-changed",
    /** The upload pipeline finished for a file item. detail: { fileId } */
    uploadComplete: "upload:complete",
    /** Force an autosave of the active note (before a file operation). */
    autosaveForce: "autosave:force",
    /** The encFile chip: the user asked to delete the file. detail: { fileId, silent? } */
    encfileDelete: "encfile:delete",
    /** encFile chip: undo a removal. detail: { fileId } */
    encfileRestore: "encfile:restore",
    /** encFile: a paste/drop needs the upload confirmed. detail: { files, noteId, parentId } */
    encfileConfirmNeeded: "encfile:confirmNeeded",
    /** encFile chip: a download request. detail: { fileId } */
    encfileDownload: "encfile:download",
    /** encFile: the file exceeds the size limit. detail: { name, maxMB } */
    encfileTooLarge: "encfile:tooLarge",
    /** encFile: a large file with no OPFS — resuming after a reload is not supported. detail: { name } */
    encfileNoResume: "encfile:noResume",
    /** An encFile chip: a request for the crop editor. detail: { fileId } */
    encfileCropRequest: "encfile:cropRequest",
    /** An encFile chip: the info button was clicked — open the detail panel. detail: { fileId } */
    encfileInfo: "encfile:info",
    /**
     * Force a reload of the open note's content from IDB or the query, even when the editor is dirty.
     * detail: { noteId: string }. Used after a conflict resolve and a multi-tab abort-save,
     * so an autosave does not overwrite the chosen or server version with stale HTML from the editor.
     */
    noteForceReload: "note:force-reload",
    /**
     * A push of a note came back 409 and `applyConflict` replaced the local row with the server's,
     * keeping this tab's version as a new conflict copy. detail: { noteId, copyId, copyTitle }.
     * NoteAutosave of an open editor moves its unsaved text into THAT copy, then reloads.
     */
    notePushConflict: "note:push-conflict",
    /**
     * A note's content was written successfully into IDB in this tab (an autosave, a file-ref strip,
     * an append…). detail: { noteId: string; content: string }. NoteAutosave moves the multi-tab
     * baseline for that noteId (a map keyed by id) so a later save, or a flush on switch, does not
     * falsely detect "updated elsewhere" (trashing a file strips refs, say, or a switch overwrites the
     * "current" note).
     */
    noteContentWritten: "note:content-written",
    /**
     * ANOTHER TAB changed which notes embed a file: a trash (the embed stripped from every note), a
     * move (stripped from the sources, appended to `toNoteId`) or a restore (appended to `toNoteId`).
     * detail: { fileId: string; toNoteId?: string }. Dispatched by the files BroadcastChannel
     * receiver (file-invalidator.ts) BEFORE the editor node is touched. NoteAutosave reconciles its
     * per-tab baseline from it — otherwise the next save in this tab sees IDB content that is neither
     * its baseline nor its editor HTML and raises a false "updated elsewhere" conflict copy.
     */
    remoteFileRefsChanged: "file:remote-refs-changed",
} as const;
