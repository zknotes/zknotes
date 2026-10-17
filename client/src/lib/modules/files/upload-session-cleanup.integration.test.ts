// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { abortUploadMock, getUploadStatusMock } = vi.hoisted(() => ({
    abortUploadMock: vi.fn().mockResolvedValue(undefined),
    getUploadStatusMock: vi.fn(),
}));

vi.mock("$lib/core/api/files", () => ({
    abortUpload: abortUploadMock,
}));

vi.mock("$lib/core/api", () => ({
    getUploadStatus: getUploadStatusMock,
}));

vi.mock("./upload-chunk-store", () => ({
    deleteAllUploadChunks: vi.fn().mockResolvedValue(undefined),
}));

const { deleteStagingMock } = vi.hoisted(() => ({
    deleteStagingMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./opfs-staging", () => ({
    deleteStaging: deleteStagingMock,
}));

import { getDB, type LocalItem, type PendingUpload } from "$lib/core/db";
import {
    abortActiveUploadSessions,
    clearAllPendingUploadsOnLogout,
    sweepStalePendingUploads,
} from "./upload-session-cleanup";

function pending(overrides: Partial<PendingUpload> = {}): PendingUpload {
    return {
        local_id: "loc-1",
        name: "f.bin",
        mime: "application/octet-stream",
        note_id: null,
        parent_id: null,
        created_at: Date.now(),
        ...overrides,
    };
}

describe("upload-session-cleanup", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
    });

    it("abortActiveUploadSessions DELETEs the active chunk_set_id", async () => {
        const db = await getDB();
        await db.put(
            "pending-uploads",
            pending({
                local_id: "loc-a",
                chunk_set_id: "cs-a",
                phase: "uploading",
            }),
        );
        await db.put(
            "pending-uploads",
            pending({
                local_id: "loc-b",
                phase: "done",
            }),
        );

        const n = await abortActiveUploadSessions();

        expect(n).toBe(1);
        expect(abortUploadMock).toHaveBeenCalledWith("cs-a");
    });

    it("clearAllPendingUploadsOnLogout deletes every row and the OPFS staging", async () => {
        const db = await getDB();
        await db.put(
            "pending-uploads",
            pending({
                local_id: "loc-opfs",
                staging_id: "loc-opfs",
                staging_bytes_written: 100,
                plain_size: 100,
                storage_mode: "opfs",
                phase: "staging_source",
            }),
        );
        await db.put(
            "pending-uploads",
            pending({
                local_id: "loc-active",
                chunk_set_id: "cs-active",
                phase: "uploading",
            }),
        );

        await clearAllPendingUploadsOnLogout();

        expect(abortUploadMock).toHaveBeenCalledWith("cs-active");
        expect(deleteStagingMock).toHaveBeenCalledWith("loc-opfs");
        expect(await db.count("pending-uploads")).toBe(0);
    });

    it("sweepStalePendingUploads removes the row when the session is a 404", async () => {
        const db = await getDB();
        const stale = Date.now() - 8 * 24 * 60 * 60 * 1000;
        await db.put(
            "pending-uploads",
            pending({
                local_id: "loc-stale",
                chunk_set_id: "cs-stale",
                phase: "paused",
                last_activity_at: stale,
                created_at: stale,
            }),
        );
        getUploadStatusMock.mockRejectedValue(new Error("not found (404)"));

        const removed = await sweepStalePendingUploads();

        expect(removed).toBe(1);
        expect(await db.get("pending-uploads", "loc-stale")).toBeUndefined();
    });
});

// The terminal rows the startup sweep releases, and the ones it must leave alone.
describe("sweepStalePendingUploads — terminal rows", () => {
    const DAY = 24 * 60 * 60 * 1000;

    function note(id: string, extra: Partial<LocalItem> = {}): LocalItem {
        return {
            id,
            type: "note",
            parent_id: null,
            encrypted_payload: "e",
            payload_nonce: "n",
            encrypted_item_key: "k",
            item_key_nonce: "kn",
            sort_order: "a",
            version: 1,
            ...extra,
        } as LocalItem;
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
        await db.clear("items");
    });

    it("releases a failed_expired row after 24 h and an orphan whose note is gone; keeps the rest", async () => {
        const db = await getDB();
        await db.put("items", note("in-trash", { deleted_at: 100 }));
        const now = Date.now();
        const rows: PendingUpload[] = [
            pending({
                local_id: "expired-old",
                phase: "failed_expired",
                last_activity_at: now - 2 * DAY,
            }),
            pending({
                local_id: "expired-new",
                phase: "failed_expired",
                last_activity_at: now - 60_000,
            }),
            pending({
                local_id: "recoverable-old",
                phase: "failed_recoverable",
                last_activity_at: now - 2 * DAY,
            }),
            pending({
                local_id: "orphan-gone",
                phase: "orphan_committed",
                chunk_set_id: "cs-1",
                parent_id: "no-such-note",
            }),
            pending({
                local_id: "orphan-trash",
                phase: "orphan_committed",
                chunk_set_id: "cs-2",
                parent_id: "in-trash",
            }),
        ];
        for (const row of rows) await db.put("pending-uploads", row);

        await sweepStalePendingUploads();

        const left = (await db.getAll("pending-uploads")).map((r) => r.local_id).sort();
        expect(left).toEqual(["expired-new", "orphan-trash", "recoverable-old"]);
        // A committed set is the GC's to collect — no DELETE /uploads for the released orphan.
        expect(abortUploadMock).not.toHaveBeenCalled();
    });
});
