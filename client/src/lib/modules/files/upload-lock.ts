// The multi-tab upload lock — a 60s lease + a monotonic fence.
// The get+put happen in ONE readwrite transaction — IDB serialises concurrent transactions across
// tabs; separate get-then-put auto-commits let both tabs acquire the lease.
// The fence: when a lease expires and another tab takes over, the old tab sees a fence mismatch and
// stops before the finalize/create (so there is no double commit).
import { getDB, type PendingUpload } from "$lib/core/db";

const LOCK_LEASE_MS = 60_000;
const TAB_ID_KEY = "zknotes_upload_tab_id";

export type UploadLockAcquire = { acquired: false } | { acquired: true; fence: number };

export function getUploadTabId(): string {
    if (typeof sessionStorage === "undefined") return "ssr";
    let id = sessionStorage.getItem(TAB_ID_KEY);
    if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem(TAB_ID_KEY, id);
    }
    return id;
}

function isLockFresh(lock: PendingUpload["upload_lock"] | undefined): boolean {
    if (!lock) return false;
    return Date.now() - lock.acquired_at < LOCK_LEASE_MS;
}

function isLockValid(lock: PendingUpload["upload_lock"] | undefined, tabId: string): boolean {
    if (!lock) return false;
    if (lock.tab_id !== tabId) return false;
    return isLockFresh(lock);
}

/** Returns a fence when the lock was acquired, or is already ours in the same tab; otherwise acquired:false. */
export async function acquireUploadLock(localId: string): Promise<UploadLockAcquire> {
    const tabId = getUploadTabId();
    const db = await getDB();
    const tx = db.transaction("pending-uploads", "readwrite");
    const store = tx.objectStore("pending-uploads");
    const pending = await store.get(localId);
    if (!pending) {
        await tx.done;
        // There is no queue row (an ephemeral upload) — nothing to fence; fence 0 is a no-op token.
        return { acquired: true, fence: 0 };
    }

    const lock = pending.upload_lock;
    if (lock && lock.tab_id !== tabId && isLockFresh(lock)) {
        await tx.done;
        return { acquired: false };
    }

    // The same tab already holds it → keep the fence; otherwise (expired, someone else's, or old) bump the epoch.
    const nextFence =
        lock && lock.tab_id === tabId && isLockFresh(lock)
            ? (lock.fence ?? 1)
            : (lock?.fence ?? 0) + 1;

    await store.put({
        ...pending,
        upload_lock: { tab_id: tabId, acquired_at: Date.now(), fence: nextFence },
        last_activity_at: Date.now(),
    });
    await tx.done;
    return { acquired: true, fence: nextFence };
}

/** Extends the lease only while the fence still belongs to this tab. false = somebody else took over. */
export async function renewUploadLock(localId: string, fence: number): Promise<boolean> {
    const tabId = getUploadTabId();
    const db = await getDB();
    const tx = db.transaction("pending-uploads", "readwrite");
    const store = tx.objectStore("pending-uploads");
    const pending = await store.get(localId);
    if (
        !pending?.upload_lock ||
        pending.upload_lock.tab_id !== tabId ||
        (pending.upload_lock.fence ?? 0) !== fence
    ) {
        await tx.done;
        return false;
    }
    await store.put({
        ...pending,
        upload_lock: { tab_id: tabId, acquired_at: Date.now(), fence },
        last_activity_at: Date.now(),
    });
    await tx.done;
    return true;
}

/** True while this tab and fence still hold the lease (with no side effect). */
export async function assertUploadFence(localId: string, fence: number): Promise<boolean> {
    const tabId = getUploadTabId();
    const db = await getDB();
    const pending = await db.get("pending-uploads", localId);
    if (!pending?.upload_lock) {
        // The row is gone, or there is no lock — fence 0 (ephemeral) passes; otherwise fail closed.
        return fence === 0;
    }
    // The ownership condition (the tab plus freshness) lives in one place — `isLockValid`; only the
    // fence, which is specific to the assertion, is added here.
    return isLockValid(pending.upload_lock, tabId) && (pending.upload_lock.fence ?? 0) === fence;
}

export async function releaseUploadLock(localId: string, fence?: number): Promise<void> {
    const tabId = getUploadTabId();
    const db = await getDB();
    const tx = db.transaction("pending-uploads", "readwrite");
    const store = tx.objectStore("pending-uploads");
    const pending = await store.get(localId);
    if (!pending?.upload_lock || pending.upload_lock.tab_id !== tabId) {
        await tx.done;
        return;
    }
    if (fence !== undefined && (pending.upload_lock.fence ?? 0) !== fence) {
        await tx.done;
        return;
    }
    const { upload_lock: _removed, ...rest } = pending;
    await store.put({ ...rest, last_activity_at: Date.now() });
    await tx.done;
}

export function isLockHeldByOtherTab(pending: PendingUpload): boolean {
    const tabId = getUploadTabId();
    const lock = pending.upload_lock;
    if (!lock) return false;
    return lock.tab_id !== tabId && isLockFresh(lock);
}
