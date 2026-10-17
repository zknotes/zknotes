// Removes the `<img data-file-id="...">` nodes for the given fileIds from every note's stored HTML.
// Decrypt → remove the nodes through a DOMParser → re-encrypt → save. The File Manager's delete flow
// and the note-level attachment delete flow both use it.

import type { NotePayload } from "@zknotes/shared";
import { APP_EVENTS } from "$lib/core/constants/events";
import { decryptManyItemPayloads } from "$lib/core/crypto/item-codec";
import { getDB } from "$lib/core/db";
import { ItemService } from "$lib/core/services/item-service";
import { sanitizeHtml } from "$lib/core/utils/dompurify";
import { emitNotesChanged } from "./files-changed-bus";

/**
 * Replaces a pending `local:` file ref with the real id in the stored note HTML (the editor may not
 * exist). `attempts` is how many times it looks for the ref, 200 ms apart. Returns true when it wrote.
 */
export async function swapFileRefInNoteContent(
    noteId: string,
    oldFileId: string,
    newFileId: string,
    attempts = 15,
): Promise<boolean> {
    const db = await getDB();
    if ((await db.get("items", noteId))?.type !== "note") return false;
    const from = `data-file-id="${oldFileId}"`;
    const to = `data-file-id="${newFileId}"`;
    for (let attempt = 0; attempt < attempts; attempt++) {
        // The look and the replace run inside the item write lock: a save already on its way (one
        // still carrying the `local:` ref, say) lands first and is read, not missed or overwritten.
        let replaced = false;
        const note = await ItemService.reencryptAndSave(noteId, (p) => {
            if (typeof p.content !== "string" || !p.content.includes(from)) return null;
            replaced = true;
            return { ...p, content: p.content.replaceAll(from, to) };
        });
        if (note === null) return false; // gone meanwhile, or it cannot be decrypted
        if (replaced) return true;

        // Because of a race with autosave.flush() on a tab change, a save carrying the pending ID may
        // still be running in the background. We wait briefly and try again.
        if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

/** Checks whether a `data-file-id` appears in a note's stored HTML. */
export function htmlContainsFileRef(html: string, fileId: string): boolean {
    return html.includes(`data-file-id="${fileId}"`);
}

export async function noteContainsFileEmbed(noteId: string, fileId: string): Promise<boolean> {
    const note = await ItemService.getDecryptedItem(noteId);
    if (note?.type !== "note") return false;
    const html = note.payload?.content;
    return typeof html === "string" && htmlContainsFileRef(html, fileId);
}

/**
 * The ONE strip transform for a note's stored HTML: remove the `<img data-file-id>` nodes of the
 * given files, re-serialise, sanitise. Pure and deterministic — the same input string always yields
 * the same output. That determinism is load-bearing: the tab that strips (removeFileRefsFromNotes)
 * and a tab that merely OBSERVES the strip (NoteAutosave's cross-tab baseline reconcile) both run
 * this function, so the observer can prove "IDB now holds my baseline minus exactly these embeds"
 * by string equality and move its baseline instead of raising a false conflict copy.
 */
export function stripFileRefsFromHtml(
    html: string,
    fileIds: readonly string[],
): { html: string; changed: boolean } {
    const idsToRemove = new Set(fileIds);
    if (!fileIds.some((fid) => html.includes(`data-file-id="${fid}"`))) {
        return { html, changed: false };
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    let changed = false;
    for (const img of Array.from(doc.querySelectorAll("img[data-file-id]"))) {
        if (idsToRemove.has(img.getAttribute("data-file-id") ?? "")) {
            img.remove();
            changed = true;
        }
    }
    if (!changed) return { html, changed: false };
    // S3 (defence in depth): the re-serialised HTML goes through the same TipTap allow-list as the
    // render and export paths before it goes back into the ciphertext. That stops the cleanup
    // perpetuating unsanitised markup if the payload ever carried any (an old import, a bug).
    return { html: sanitizeHtml(doc.body.innerHTML), changed: true };
}

/** Returns the ids of the notes whose content really changed. */
export async function removeFileRefsFromNotes(
    noteIds: string[],
    fileIds: string[],
): Promise<string[]> {
    if (noteIds.length === 0) return [];
    const changedNoteIds: string[] = [];

    const db = await getDB();
    const noteRows = (await Promise.all(noteIds.map((id) => db.get("items", id)))).filter(
        (item): item is NonNullable<typeof item> => item != null && item.type === "note",
    );
    if (noteRows.length === 0) return [];

    // Batch decrypt (query "perf 9") instead of one ItemService.getDecryptedItem (a worker round
    // trip) per note — a file delete/move used to decrypt EVERY live note in the vault one at a time.
    const results = await decryptManyItemPayloads<NotePayload>(noteRows);
    const payloadById = new Map(
        results.filter((r) => r.data !== undefined).map((r) => [r.id, r.data as NotePayload]),
    );

    for (const note of noteRows) {
        const payload = payloadById.get(note.id);
        const html = payload?.content;
        if (!html) continue;

        // stripFileRefsFromHtml's own cheap pre-check (query "perf 9") skips the DOMParser pass for a
        // note that mentions none of the target file ids — the overwhelming majority, in practice.
        const stripped = stripFileRefsFromHtml(html, fileIds);
        if (stripped.changed) {
            await ItemService.updateItemPayload(
                note.id,
                payload?.contentTitle || payload?.title || "Untitled",
                stripped.html,
            );
            changedNoteIds.push(note.id);
        }
    }
    return changedNoteIds;
}

/**
 * A real move is a reparent + the embed (FileService.move). The old path only moved the embed and
 * left parent_id in place — which breaks the 1:1 owner-note model.
 */
export async function moveFileEmbedBetweenNotes(
    fileId: string,
    fromNoteId: string,
    toNoteId: string,
    fileName: string,
    mime?: string,
): Promise<void> {
    if (fromNoteId === toNoteId) return;
    const { FileService } = await import("./file-service");
    await FileService.move(fileId, toNoteId, fileName, mime);
}

/**
 * Removes the refs from EVERY live note in the vault. A note's content is the source of truth — a
 * file may be embedded in a note that is not its parent_id owner (legacy moves, a paste), so a
 * "move" has to walk every note, not just the old parent.
 */
export async function removeFileRefsEverywhere(
    fileIds: string[],
    opts: { includeTrashedNotes?: boolean; excludeNoteIds?: string[] } = {},
): Promise<string[]> {
    const db = await getDB();
    const items = await db.getAll("items");
    const exclude = new Set(opts.excludeNoteIds ?? []);
    const noteIds = items
        .filter(
            (i) =>
                i.type === "note" &&
                (opts.includeTrashedNotes || !i.deleted_at) &&
                !exclude.has(i.id),
        )
        .map((i) => i.id);
    return removeFileRefsFromNotes(noteIds, fileIds);
}

/**
 * A full orphan cleanup for permanently deleted files: it removes the live node from the open
 * editor BEFORE the stored-content strip (the order matters — see the note below), then strips the
 * stored content (trashed notes included, the cascade case), and finally tells the note bus to
 * invalidate the queries.
 */
export async function cleanupOrphanedFileRefs(fileIds: string[]): Promise<string[]> {
    if (fileIds.length === 0) return [];
    // 1. The live doc FIRST (silently) — see the note on ordering below.
    if (typeof document !== "undefined") {
        for (const fileId of fileIds) {
            document.dispatchEvent(
                new CustomEvent(APP_EVENTS.encfileDelete, { detail: { fileId, silent: true } }),
            );
        }
    }
    // 2. The stored (ciphertext) content — trashed notes included (the cascade restore case).
    const stripped = await removeFileRefsEverywhere(fileIds, { includeTrashedNotes: true });
    // 3. The query invalidation for the notes NOT currently open in the editor.
    if (stripped.length > 0) emitNotesChanged(stripped);
    return stripped;
}
