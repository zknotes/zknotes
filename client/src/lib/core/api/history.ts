// The domain client for the /items/:id/history endpoints. The snapshot policy (the
// localRev check, the decryption) stays in sync/history.ts.
import type { CreateHistorySnapshot, HistorySnapshot } from "@zknotes/shared";
import { apiFetch } from "./client";

/** POST — stores an encrypted snapshot of an item's current state. */
export async function createSnapshot(body: CreateHistorySnapshot): Promise<HistorySnapshot> {
    return apiFetch(`/items/${body.item_id}/history`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

/** GET — a paginated list of snapshots (the newest first). */
export async function listSnapshots(
    itemId: string,
    opts: { limit?: number; before?: number } = {},
): Promise<{ snapshots: HistorySnapshot[]; total: number }> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.before !== undefined) params.set("before", String(opts.before));
    const qs = params.toString();
    return apiFetch(`/items/${itemId}/history${qs ? `?${qs}` : ""}`);
}

/** DELETE — deletes one snapshot. */
export async function deleteSnapshot(itemId: string, snapshotId: string): Promise<void> {
    await apiFetch(`/items/${itemId}/history/${snapshotId}`, { method: "DELETE" });
}

/** DELETE — deletes every snapshot of an item. */
export async function clearAllSnapshots(itemId: string): Promise<void> {
    await apiFetch(`/items/${itemId}/history`, { method: "DELETE" });
}
