// A one-off cleanup of "ghost" file items: type:"file" rows in the local DB whose chunk set no
// longer exists on the server (left behind by a server reset during development, say). Without it
// their thumbnails and previews 404 forever. Strictly conditional on a definitive HTTP 404 for chunk
// 0 — a temporary offline failure is never read as missing, so real files are never discarded.

import type { FilePayload } from "@zknotes/shared";
import { chunkStatus } from "$lib/core/api";
import { decryptManyItemPayloads } from "$lib/core/crypto/item-codec";
import { getDB } from "$lib/core/db";

let ran = false;

// Chunked batch decrypt (query "perf 5") instead of one worker round trip per file. `LAST_PRUNE_KEY`
// throttles the whole scan — including its per-file HEAD requests — to once/day across page loads;
// `ran` still guards against re-running within the same loaded page (multiple layout mounts).
const PRUNE_CHUNK_SIZE = 200;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_PRUNE_KEY = "zk_last_prune_at";

function shouldRunToday(): boolean {
    try {
        const last = Number(localStorage.getItem(LAST_PRUNE_KEY) ?? "0");
        return !Number.isFinite(last) || Date.now() - last >= PRUNE_INTERVAL_MS;
    } catch {
        return true; // localStorage unavailable (SSR/tests) — never block the scan on that
    }
}

function markRunToday(): void {
    try {
        localStorage.setItem(LAST_PRUNE_KEY, String(Date.now()));
    } catch {
        // Best-effort only — worst case it reruns next load.
    }
}

/** Returns how many ghost file items were pruned. Runs at most once per page session, and at most
 * once per day across sessions (its own HEAD-per-file network sweep is otherwise expensive to repeat
 * on every page load). */
export async function pruneBrokenFiles(): Promise<number> {
    if (ran) return 0;
    ran = true;
    if (!shouldRunToday()) return 0;
    markRunToday();

    const db = await getDB();
    const items = await db.getAll("items");
    const files = items.filter((i) => i.type === "file" && !i.deleted_at);

    let pruned = 0;
    for (let i = 0; i < files.length; i += PRUNE_CHUNK_SIZE) {
        const chunk = files.slice(i, i + PRUNE_CHUNK_SIZE);
        const byId = new Map(chunk.map((item) => [item.id, item]));
        const results = await decryptManyItemPayloads<Partial<FilePayload>>(chunk);

        for (const r of results) {
            const item = byId.get(r.id);
            if (!item || r.data === undefined) continue; // undecryptable right now → leave it untouched
            const chunkSetId = r.data.chunkSetId;
            if (!chunkSetId) continue;

            if ((await chunkStatus(chunkSetId, 0)) !== "missing") continue; // prune only on a real 404

            // Never hard-delete an item row on a bare HEAD 404 — the server row may still be alive
            // (an S3 ghost, a proxy 404). Dirty/pending mutations we especially do not touch.
            if (item.dirty) continue;

            try {
                // Clear only the local ciphertext cache + the UI cache — do not delete the IDB item
                // (sync_deleted_log / the pull purge are the authority on a hard delete).
                if (item.chunk_set_id) {
                    const { evictChunkSet } = await import("$lib/core/files/chunk-loader");
                    await evictChunkSet(item.chunk_set_id).catch(() => {});
                }
                const { invalidate } = await import("./blob-cache");
                invalidate(item.id);
                pruned++;
            } catch (e) {
                console.warn("prune: failed to clear ghost file cache", item.id, e);
            }
        }
    }
    return pruned;
}
