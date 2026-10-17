/**
 * The IDB-aware "is the vault clean" predicate for the login gate.
 * It uses neither the cached `syncStore.pendingCount` nor the in-memory `isUploadBlockingUnload`.
 */
import { getDB, type UploadPhase } from "$lib/core/db";

/** The terminal phases of a pending upload — kept in step with `modules/files/upload-state.ts`. */
const TERMINAL_UPLOAD_PHASES: ReadonlySet<UploadPhase> = new Set([
    "done",
    "user_aborted",
    "failed_expired",
]);

export type UnsyncedWork = {
    /** Unique dirty item ids ∪ mutation-queue ids (delete-only ones included). */
    dirtyCount: number;
    /** Items parked with a permanent `sync_error` (removed from the mutation queue). */
    failedCount: number;
    /** How many pending-upload rows are not in a terminal phase. */
    uploadsActive: number;
};

export function isVaultClean(work: UnsyncedWork): boolean {
    return work.dirtyCount === 0 && work.uploadsActive === 0;
}

export async function getUnsyncedWork(): Promise<UnsyncedWork> {
    const db = await getDB();
    const ids = new Set<string>();
    let failedCount = 0;

    for (const item of await db.getAll("items")) {
        if (item.dirty === true) ids.add(item.id);
        if (item.sync_error) failedCount += 1;
    }
    for (const mut of await db.getAll("mutation-queue")) {
        ids.add(mut.id);
    }

    let uploadsActive = 0;
    for (const pending of await db.getAll("pending-uploads")) {
        const phase = pending.phase;
        if (!phase || !TERMINAL_UPLOAD_PHASES.has(phase)) uploadsActive += 1;
    }

    return { dirtyCount: ids.size, failedCount, uploadsActive };
}
