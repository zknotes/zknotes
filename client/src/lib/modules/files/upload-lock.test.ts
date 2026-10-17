import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDB, type PendingUpload } from "$lib/core/db";
import {
    acquireUploadLock,
    assertUploadFence,
    getUploadTabId,
    releaseUploadLock,
    renewUploadLock,
} from "./upload-lock";

async function seedPending(over: Partial<PendingUpload> = {}): Promise<string> {
    const localId = over.local_id ?? "pending-1";
    const db = await getDB();
    await db.put("pending-uploads", {
        local_id: localId,
        name: "a.bin",
        mime: "application/octet-stream",
        note_id: null,
        parent_id: null,
        created_at: Date.now(),
        phase: "uploading",
        ...over,
    } as PendingUpload);
    return localId;
}

beforeEach(async () => {
    const db = await getDB();
    await db.clear("pending-uploads");
    // Every test gets a fresh tab id (sessionStorage under happy-dom/vitest).
    if (typeof sessionStorage !== "undefined") {
        sessionStorage.removeItem("zknotes_upload_tab_id");
    }
});

describe("upload-lock fence", () => {
    it("acquire returns fence and renew succeeds for same fence", async () => {
        const id = await seedPending();
        const acq = await acquireUploadLock(id);
        expect(acq.acquired).toBe(true);
        if (!acq.acquired) return;
        expect(acq.fence).toBeGreaterThanOrEqual(1);
        expect(await renewUploadLock(id, acq.fence)).toBe(true);
        expect(await assertUploadFence(id, acq.fence)).toBe(true);
    });

    it("takeover after expired lease bumps fence; old fence fails assert", async () => {
        const id = await seedPending();
        const first = await acquireUploadLock(id);
        expect(first.acquired).toBe(true);
        if (!first.acquired) return;

        // Simulate an expired lease + another tab: an old lock set in the past under someone else's tab_id.
        const db = await getDB();
        const row = await db.get("pending-uploads", id);
        expect(row).toBeTruthy();
        await db.put("pending-uploads", {
            ...row!,
            upload_lock: {
                tab_id: "other-tab",
                acquired_at: Date.now() - 120_000,
                fence: first.fence,
            },
        });

        // Our tab (with a new session id) takes over — the fence has to go up.
        if (typeof sessionStorage !== "undefined") {
            sessionStorage.setItem("zknotes_upload_tab_id", "tab-b");
        }
        const second = await acquireUploadLock(id);
        expect(second.acquired).toBe(true);
        if (!second.acquired) return;
        expect(second.fence).toBe(first.fence + 1);

        // The old fence no longer passes.
        if (typeof sessionStorage !== "undefined") {
            sessionStorage.setItem("zknotes_upload_tab_id", getUploadTabId());
        }
        // Back to the tab that held the first fence — it does not hold the lock.
        if (typeof sessionStorage !== "undefined") {
            sessionStorage.setItem("zknotes_upload_tab_id", "tab-a-old");
        }
        expect(await assertUploadFence(id, first.fence)).toBe(false);
        expect(await renewUploadLock(id, first.fence)).toBe(false);
    });

    it("fresh lock held by other tab → acquire fails", async () => {
        const id = await seedPending({
            upload_lock: {
                tab_id: "other",
                acquired_at: Date.now(),
                fence: 3,
            },
        });
        const acq = await acquireUploadLock(id);
        expect(acq.acquired).toBe(false);
    });

    it("release only clears lock when fence matches", async () => {
        const id = await seedPending();
        const acq = await acquireUploadLock(id);
        expect(acq.acquired).toBe(true);
        if (!acq.acquired) return;

        await releaseUploadLock(id, acq.fence + 99); // the wrong fence
        let row = await (await getDB()).get("pending-uploads", id);
        expect(row?.upload_lock).toBeTruthy();

        await releaseUploadLock(id, acq.fence);
        row = await (await getDB()).get("pending-uploads", id);
        expect(row?.upload_lock).toBeUndefined();
    });
});
