// A per-note registry for the in-flight promote staging.
// NoteAutosave imports this from modules/files — the same precedent as pending-trash.

export type InFlightPromoteEntry = {
    localId: string;
    dataUrl: string;
    alt: string;
};

/** noteId → the active staging jobs (with a dataUrl for a forced-flush restore). */
const byNote = new Map<string, Map<string, InFlightPromoteEntry>>();

/** noteId → AbortController to cancel with (external pull / switch). */
const aborts = new Map<string, AbortController>();

export function inFlightPromoteCount(noteId: string): number {
    return byNote.get(noteId)?.size ?? 0;
}

export function getInFlightEntries(noteId: string): InFlightPromoteEntry[] {
    const m = byNote.get(noteId);
    return m ? [...m.values()] : [];
}

/** The abort signal for a note's current staging batch (or a new controller). */
export function getOrCreatePromoteAbort(noteId: string): AbortSignal {
    let ac = aborts.get(noteId);
    if (!ac || ac.signal.aborted) {
        ac = new AbortController();
        aborts.set(noteId, ac);
    }
    return ac.signal;
}

export function trackInFlight(noteId: string, entry: InFlightPromoteEntry): void {
    let m = byNote.get(noteId);
    if (!m) {
        m = new Map();
        byNote.set(noteId, m);
    }
    m.set(entry.localId, entry);
}

export function untrackInFlight(noteId: string, localId: string): void {
    const m = byNote.get(noteId);
    if (!m) return;
    m.delete(localId);
    if (m.size === 0) byNote.delete(noteId);
}

/**
 * Aborts every in-flight job and clears the note's registry.
 * Called before loadContent on an external update or a note switch.
 */
export function clearNotePromote(noteId: string): void {
    const ac = aborts.get(noteId);
    if (ac && !ac.signal.aborted) ac.abort();
    aborts.delete(noteId);
    byNote.delete(noteId);
}

/**
 * A forced flush: in the HTML, swap any still-in-flight `data-file-id="local:…"` back to
 * `src="data:…"`. It leaves already-staged local: refs (which are not in the registry) alone.
 */
export function restoreInFlightDataUrls(html: string, noteId: string): string {
    const entries = getInFlightEntries(noteId);
    if (entries.length === 0 || !html.includes("data-file-id")) return html;

    let out = html;
    for (const { localId, dataUrl } of entries) {
        const needle = `data-file-id="local:${localId}"`;
        const needleSq = `data-file-id='local:${localId}'`;
        // Put src back in place of data-file-id (the surgical inverse of the rewrite).
        if (out.includes(needle)) {
            out = out.split(needle).join(`src="${dataUrl}"`);
        } else if (out.includes(needleSq)) {
            out = out.split(needleSq).join(`src='${dataUrl}'`);
        }
    }
    return out;
}
