// One call for "a file changed or went away": clear the blob/thumbnail cache and tell the encFile
// NodeViews (and the other tabs) to re-render.
// It used to be repeated as a pair of dynamic imports (blob-cache.invalidate + notifyFileInvalidated)
// in 5 places — where invalidate() already notifies internally, so the pair notified twice.

/** Best-effort — callers typically fire and forget (`void invalidateFile(id)`). */
export async function invalidateFile(fileId: string): Promise<void> {
    const { invalidate } = await import("./blob-cache");
    invalidate(fileId);
}
