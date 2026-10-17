// The blob sweeper plus the reconciliation scheduler — lifted out of the bootstrap file.
// runGc(): deletes auth sessions, dead upload sessions, and pending_delete blobs (BLOB_PURGE_GRACE).
// runDeepRepair(): FS scan, orphan cleanup, committed without an item → pending_delete.
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import ms from "ms";
import { runDeepRepairIfDue, runGc } from "./gc";

export interface GcTickDeps {
    log: FastifyBaseLogger;
    /** GC_DEEP_INTERVAL_MS in seconds. */
    deepIntervalSeconds: number;
    runGc?: typeof runGc;
    runDeepRepairIfDue?: typeof runDeepRepairIfDue;
}

/**
 * One GC tick: the ordinary sweep, then — in the same tick — the deep repair when it is due. The
 * deep repair used to have a setInterval of its own, started with the process and written down
 * nowhere: a deploy more often than GC_DEEP_INTERVAL_MS meant it never ran, and a deep tick that
 * met a busy ordinary one was skipped for another week. Now every tick asks `gc_runs`.
 */
export function createGcTick(deps: GcTickDeps): () => Promise<void> {
    const sweep = deps.runGc ?? runGc;
    const deepIfDue = deps.runDeepRepairIfDue ?? runDeepRepairIfDue;
    let gcBusy = false;

    return async () => {
        if (gcBusy) return;
        gcBusy = true;
        try {
            try {
                const r = await sweep();
                if (
                    r.authSessions ||
                    r.signInFailures ||
                    r.uploadSessions ||
                    r.blobsPurged ||
                    r.orphanChunkSetsMarked ||
                    r.itemTombstones ||
                    r.deletedLogRows
                ) {
                    deps.log.info(
                        `[sweeper] ${r.authSessions} auth session(s), ` +
                            `${r.signInFailures} sign-in failure run(s), ` +
                            `${r.uploadSessions} upload session(s), ` +
                            `${r.blobsPurged} blob(s) purged, ` +
                            `${r.bytesReclaimed}B reclaimed, ` +
                            `${r.orphanChunkSetsMarked} orphan chunk_set(s) marked, ` +
                            `${r.itemTombstones} tombstone(s), ` +
                            `${r.deletedLogRows} deleted-log row(s) expired`,
                    );
                }
            } catch (e) {
                deps.log.error(e, "sweeper tick failed");
            }
            // A failed sweep does not skip the deep repair: that repair is the net for what the sweep misses.
            try {
                const d = await deepIfDue({ intervalSeconds: deps.deepIntervalSeconds });
                if (d) {
                    deps.log.info(
                        `[deep-repair] ${d.orphanDirs} orphan dir(s), ` +
                            `${d.ghostRows} ghost row(s), ` +
                            `${d.committedOrphans} committed orphan(s) → pending_delete`,
                    );
                }
            } catch (e) {
                deps.log.error(e, "deep repair failed");
            }
        } finally {
            gcBusy = false;
        }
    };
}

export function startGcScheduler(fastify: FastifyInstance): void {
    if (process.env.GC_DISABLED === "1") return;

    const GC_INTERVAL_MS = Number(process.env.GC_INTERVAL_MS ?? ms("15m"));
    const DEEP_INTERVAL_MS = Number(process.env.GC_DEEP_INTERVAL_MS ?? ms("7d"));
    const tick = createGcTick({
        log: fastify.log,
        deepIntervalSeconds: Math.floor(DEEP_INTERVAL_MS / 1000),
    });

    setTimeout(() => void tick(), ms("30s")).unref?.();
    setInterval(() => void tick(), GC_INTERVAL_MS).unref?.();
}
