/**
 * A best-effort eviction of cached chunk GET responses.
 *
 * The primary target is the IndexedDB `file-chunks` store (the caller handles that). Here we delete
 * the entries in the Cache Storage API that match `/uploads/` — the native HTTP disk cache has no
 * selective delete API, so this covers future SW-cached chunks without touching the app-shell
 * precache (`zknotes-shell-*`).
 */
export async function evictChunkHttpCache(): Promise<void> {
    if (typeof caches === "undefined") return;
    try {
        for (const name of await caches.keys()) {
            if (name.startsWith("zknotes-shell-")) continue;
            const cache = await caches.open(name);
            for (const req of await cache.keys()) {
                if (req.url.includes("/uploads/")) {
                    await cache.delete(req);
                }
            }
        }
    } catch (e) {
        console.warn("[evictChunkHttpCache] failed", e);
    }
}
