// `local:` uploads whose node the editor removed, while the removal grace runs. A module of its
// own, so pending-trash can mark a removal synchronously and upload-manager can read the mark the
// moment an upload finishes — neither has to import the other, and no finish slips in between.

/** Uploads whose removal grace is running. */
const held = new Set<string>();
/**
 * The file each held upload finished as. It outlives the grace, so an undo that comes after it can
 * still find the file (in the Trash by then) — the same as for a file that was already uploaded.
 */
const finishedAs = new Map<string, string>();
/** Uploads whose grace ran out while they still ran: a finish that could not be stopped is trashed. */
const abandoned = new Set<string>();

/** The editor removed this upload's node: the removal grace decides what becomes of the upload. */
export function holdRemovedUpload(localId: string): void {
    held.add(localId);
}

/**
 * Where a finished upload puts its file: `"trash"` — its grace ran out meanwhile; `"hold"` — its
 * node is still removed, so nothing is swapped or patched and the file waits for an undo or the end
 * of the grace; `"place"` — the usual swap into the editor.
 */
export function placeFinishedUpload(localId: string, fileId: string): "trash" | "hold" | "place" {
    if (abandoned.delete(localId)) {
        finishedAs.set(localId, fileId);
        return "trash";
    }
    if (!held.has(localId)) return "place";
    finishedAs.set(localId, fileId);
    return "hold";
}

/** An undo brought the node back: the file its upload finished as meanwhile, if it did. */
export function releaseRemovedUpload(localId: string): string | undefined {
    held.delete(localId);
    const fileId = finishedAs.get(localId);
    finishedAs.delete(localId);
    return fileId;
}

/**
 * The grace ran out: the file the upload finished as, which goes to the Trash. An upload that has
 * not finished is marked abandoned first, so a finish that can no longer be stopped goes there too.
 */
export function abandonRemovedUpload(localId: string): string | undefined {
    held.delete(localId);
    const fileId = finishedAs.get(localId);
    if (!fileId) abandoned.add(localId);
    return fileId;
}

/** A run that ended without a file drops its abandoned mark. */
export function forgetAbandonedUpload(localId: string): void {
    abandoned.delete(localId);
}
