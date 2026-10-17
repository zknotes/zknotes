// The outbox — the mutation queue every local change goes through before it reaches the server:
// enqueueing, the retry backoff and the queue-change listeners. The push drains it; the pull and the
// conflict helpers only add to it.
import { getDB, type MutationQueueItem } from "$lib/core/db";
import { MINUTE_MS, SECOND_MS } from "$lib/core/utils/duration";
import { syncStore } from "./store.svelte";

/** The IndexedDB handle the sync modules pass around. */
export type DB = Awaited<ReturnType<typeof getDB>>;

const RETRY_DELAYS = [SECOND_MS, 5 * SECOND_MS, 15 * SECOND_MS, MINUTE_MS, 5 * MINUTE_MS]; // 1s → 5min

/**
 * The jitter factor in [0.8, 1.2) for one mutation's attempt — derived from the id and the attempt
 * (FNV-1a) rather than Math.random(). Retries still spread across items and clients, but the due
 * time is fixed, so the scheduler's retry timer and the Sync panel's countdown see the same moment
 * as the drain. A random roll per check (the old way) gave every caller a different answer.
 */
function jitterFactor(id: string, attemptCount: number): number {
    const key = `${id}:${attemptCount}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return 0.8 + ((hash >>> 0) / 2 ** 32) * 0.4;
}

type RetryFields = Pick<MutationQueueItem, "id" | "attempt_count" | "attempted_at">;

/**
 * When the mutation is due for its next push attempt (a ms timestamp). A fresh mutation
 * (`attempt_count: 0`) is due at once → 0. The one definition of the backoff — the drain, the
 * scheduler's retry timer and the Sync panel all read it.
 */
export function mutationRetryAt(m: RetryFields): number {
    if (m.attempt_count === 0) return 0;
    const baseDelay = RETRY_DELAYS[Math.min(m.attempt_count - 1, RETRY_DELAYS.length - 1)] ?? 0;
    // Whole milliseconds, rounded up — Date.now() is an integer, and the due time must never
    // come before the jittered delay.
    return m.attempted_at + Math.ceil(baseDelay * jitterFactor(m.id, m.attempt_count));
}

export function shouldRetry(m: RetryFields): boolean {
    return mutationRetryAt(m) <= Date.now();
}

/** The earliest moment a queued mutation is due (a ms timestamp), or null when the queue is empty. */
export async function nextMutationRetryAt(): Promise<number | null> {
    const db = await getDB();
    const queue = await db.getAll("mutation-queue");
    if (queue.length === 0) return null;
    return Math.min(...queue.map(mutationRetryAt));
}

// The scheduler subscribes here to re-arm its retry timer. A listener registry rather than an
// import of the scheduler: the scheduler already imports this module.
const queueListeners = new Set<() => void>();

/** Called after an enqueue and after every drain (attempt counts may have changed). Returns the unsubscribe. */
export function onMutationQueueChanged(listener: () => void): () => void {
    queueListeners.add(listener);
    return () => {
        queueListeners.delete(listener);
    };
}

export function notifyQueueChanged(): void {
    for (const listener of queueListeners) listener();
}

/** The one definition (it used to be copied into ItemService.ts and files/upload.ts as well). */
export async function enqueueMutation(id: string, type: "upsert" | "delete") {
    const db = await getDB();
    await db.put("mutation-queue", { id, type, attempted_at: 0, attempt_count: 0 });
    // The only chokepoint for enqueueing → refresh the pending counter here.
    void syncStore.refreshPendingCount();
    notifyQueueChanged();
}

/** A legacy migration — queues local items from before the sync engine was rewritten. */
export async function migrateLegacyItems(): Promise<void> {
    const db = await getDB();
    const allItems = await db.getAll("items");
    let migrated = 0;

    for (const item of allItems) {
        // The old ItemService used Date.now() for the version; the new one uses the server version
        // (small integers). A version over a billion, or an undefined dirty, means a legacy unsynced item.
        if (item.version > 1_000_000_000 || item.dirty === undefined) {
            item.version = 1; // The server accepts 1 for new items, or we get a conflict if it already exists
            item.dirty = true;
            item.localRev = item.localRev ?? 0;
            await db.put("items", item);
            await enqueueMutation(item.id, "upsert");
            migrated++;
        }
    }

    if (migrated > 0) {
        console.log(`Migrated ${migrated} legacy items to the mutation queue`);
    }
}

/** True when the mutation queue holds at least one mutation (used to decide on tree invalidation). */
export async function hasPendingMutations(): Promise<boolean> {
    const db = await getDB();
    return (await db.count("mutation-queue")) > 0;
}
