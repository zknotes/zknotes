import { FileLifecycle } from "$lib/core/utils/file-lifecycle";

/** The sum of the ciphertext_size of the TRASHED files in IndexedDB (a faster local signal than the API quota). */
export async function localTrashedFileBytes(): Promise<number> {
    try {
        const { getDB } = await import("$lib/core/db");
        const db = await getDB();
        const all = await db.getAll("items");
        return all
            .filter(
                (i) =>
                    i.type === "file" &&
                    FileLifecycle.stateOf(i) === "TRASHED" &&
                    i.ciphertext_size,
            )
            .reduce((sum, i) => sum + (i.ciphertext_size ?? 0), 0);
    } catch {
        return 0;
    }
}

/**
 * Live trash usage for UI bars.
 *
 * Prefer local TRASHED file bytes — IndexedDB updates immediately on trash / restore / purge.
 * API `trashed_bytes` lags until soft-delete or purge sync lands, so `Math.max(api, local)`
 * kept showing the old size after Empty trash until a manual refresh.
 *
 * Soft-delete: local rises first → local is correct.
 * Hard-delete / empty: local falls first → local is correct.
 *
 * `apiTrashed` is kept in the signature for call-site compatibility and as a future
 * multi-device floor if we reintroduce a hybrid; not used for display today.
 */
export function effectiveTrashedBytes(_apiTrashed: number, localFileTrashBytes: number): number {
    return localFileTrashBytes;
}
