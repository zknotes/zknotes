// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalItem } from "$lib/core/db";

const { startNewUploadMock, resumeUploadMock, swapFileRefMock, pingOrExpireMock, trashMock } =
    vi.hoisted(() => ({
        startNewUploadMock: vi.fn(),
        resumeUploadMock: vi.fn(),
        swapFileRefMock: vi.fn().mockResolvedValue(true),
        pingOrExpireMock: vi.fn(),
        trashMock: vi.fn().mockResolvedValue(undefined),
    }));

vi.mock("./file-service", () => ({
    FileService: { trash: trashMock },
}));

vi.mock("./upload", () => ({
    startNewUpload: startNewUploadMock,
    resumeUpload: resumeUploadMock,
    replaceFileContent: vi.fn(),
}));

vi.mock("./cleanup", () => ({
    swapFileRefInNoteContent: swapFileRefMock,
}));

vi.mock("./files-changed-bus", () => ({
    emitFilesChanged: vi.fn(),
    emitNotesChanged: vi.fn(),
}));

vi.mock("./upload-heartbeat", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./upload-heartbeat")>()),
    pingOrExpire: pingOrExpireMock,
}));

import { ApiError } from "$lib/core/api/client";
import { APP_EVENTS } from "$lib/core/constants/events";
import { getDB, type PendingUpload } from "$lib/core/db";
import { LOCAL_PREFIX } from "./refs";
import { getUnsyncedWork } from "$lib/core/sync/unsynced-work";
import type { Editor } from "@tiptap/core";
import { resumePendingUploads } from "./editor-images";
import { UploadPipelineError } from "./upload-errors";
import {
    abortPendingUpload,
    getUploadState,
    isUploadBlockingUnload,
    pingPausedUploads,
    reconcileOrphanUploads,
    reconcileSyncingUploads,
    resumeAllPendingUploads,
    startUpload,
    subscribeUpload,
    abortRemovedUpload,
} from "./upload-manager";
import { shouldResumeOnStartup } from "./upload-state";
import { abandonRemovedUpload, holdRemovedUpload, releaseRemovedUpload } from "./removed-uploads";

function uploadedItem(id: string): LocalItem {
    return {
        id,
        type: "file",
        parent_id: null,
        encrypted_payload: "enc",
        payload_nonce: "nonce",
        encrypted_item_key: "ik",
        item_key_nonce: "ikn",
        chunk_set_id: "cs-1",
        chunk_count: 1,
        ciphertext_size: 48,
        sort_order: id,
        version: 1,
        dirty: true,
        localRev: 0,
    } as LocalItem;
}

function pending(localId: string, overrides: Partial<PendingUpload> = {}): PendingUpload {
    return {
        local_id: localId,
        phase: "staging_source",
        blob: new File([new Uint8Array([1])], "pic.png", { type: "image/png" }),
        name: "pic.png",
        mime: "image/png",
        plain_size: 1,
        note_id: null,
        parent_id: null,
        created_at: 1,
        last_activity_at: 1,
        manifest: {},
        ...overrides,
    };
}

describe("upload-manager", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
        startNewUploadMock.mockResolvedValue(uploadedItem("real-file-id"));
        resumeUploadMock.mockResolvedValue(uploadedItem("real-file-id"));
    });

    afterEach(async () => {
        await abortPendingUpload(null, "loc-1").catch(() => {});
        await abortPendingUpload(null, "loc-2").catch(() => {});
        await abortPendingUpload(null, "loc-dup").catch(() => {});
    });

    it("ignores duplicate startUpload while the same local_id is in flight", async () => {
        let release!: () => void;
        startNewUploadMock.mockImplementation(
            () =>
                new Promise<LocalItem>((resolve) => {
                    release = () => resolve(uploadedItem("real-file-id"));
                }),
        );

        const p = pending("loc-dup");
        const first = startUpload(null, p);
        await new Promise((r) => setTimeout(r, 0));
        await startUpload(null, p);
        await new Promise((r) => setTimeout(r, 0));

        expect(startNewUploadMock).toHaveBeenCalledTimes(1);
        release();
        await first;
    });

    it("uses resumeUpload when pending has chunk_set_id in resumable phase", async () => {
        const db = await getDB();
        const row = pending("loc-1", {
            chunk_set_id: "cs-existing",
            phase: "paused",
            item_id: "file-1",
        });
        await db.put("pending-uploads", row);

        await startUpload(null, row);

        expect(resumeUploadMock).toHaveBeenCalledOnce();
        expect(startNewUploadMock).not.toHaveBeenCalled();
    });

    it("swaps local: ref in note content when editor is null", async () => {
        const db = await getDB();
        await db.put("pending-uploads", pending("loc-1", { note_id: "note-1" }));

        await startUpload(null, pending("loc-1", { note_id: "note-1" }));

        // No editor: the default attempts, which wait for a save still carrying the `local:` ref.
        expect(swapFileRefMock).toHaveBeenCalledWith(
            "note-1",
            `${LOCAL_PREFIX}loc-1`,
            "real-file-id",
            undefined,
        );
        expect(await db.get("pending-uploads", "loc-1")).toBeUndefined();
        expect(getUploadState("loc-1")).toBeUndefined();
    });

    it("notifies subscribers while upload progresses", async () => {
        const hits: string[] = [];
        const unsub = subscribeUpload("loc-2", () => hits.push("tick"));

        startNewUploadMock.mockImplementation(async (_file, _parent, opts) => {
            opts?.onProgress?.({ phase: "uploading", chunkIndex: 0, totalChunks: 1 });
            return uploadedItem("real-file-id");
        });

        await startUpload(null, pending("loc-2"));
        unsub();

        expect(hits.length).toBeGreaterThan(0);
        expect(getUploadState("loc-2")).toBeUndefined();
    });

    it("abortPendingUpload clears pending row and upload state", async () => {
        let release!: () => void;
        startNewUploadMock.mockImplementation(
            () =>
                new Promise<LocalItem>((resolve) => {
                    release = () => resolve(uploadedItem("real-file-id"));
                }),
        );

        const db = await getDB();
        await db.put("pending-uploads", pending("loc-1"));
        void startUpload(null, pending("loc-1"));

        await Promise.resolve();
        await abortPendingUpload(null, "loc-1");
        release();

        expect(await db.get("pending-uploads", "loc-1")).toBeUndefined();
        expect(getUploadState("loc-1")).toBeUndefined();
    });

    it("isUploadBlockingUnload returns true while upload is active", async () => {
        let release!: () => void;
        startNewUploadMock.mockImplementation(
            () =>
                new Promise<LocalItem>((resolve) => {
                    release = () => resolve(uploadedItem("real-file-id"));
                }),
        );

        void startUpload(null, pending("loc-1"));
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(isUploadBlockingUnload()).toBe(true);

        release();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(isUploadBlockingUnload()).toBe(false);
    });
});

describe("upload-manager — the `syncing` rows (the staging outlives the local commit)", () => {
    it("a `syncing` row is kept while its item is dirty and released once the push is acknowledged", async () => {
        const db = await getDB();
        await db.clear("pending-uploads");
        const item = uploadedItem("file-sync-1"); // dirty: true — not yet acknowledged by the server
        await db.put("items", item);
        await db.put(
            "pending-uploads",
            pending("loc-sync", { phase: "syncing", item_id: "file-sync-1", chunk_set_id: "cs-1" }),
        );

        expect(await reconcileSyncingUploads()).toBe(0);
        expect(await db.get("pending-uploads", "loc-sync")).toBeDefined();

        await db.put("items", { ...item, dirty: false });
        expect(await reconcileSyncingUploads()).toBe(1);
        expect(await db.get("pending-uploads", "loc-sync")).toBeUndefined();
    });

    it("a `syncing` row whose item is gone is released — nothing left to protect", async () => {
        const db = await getDB();
        await db.clear("pending-uploads");
        await db.put(
            "pending-uploads",
            pending("loc-gone", { phase: "syncing", item_id: "file-gone", chunk_set_id: "cs-1" }),
        );

        expect(await reconcileSyncingUploads()).toBe(1);
        expect(await db.get("pending-uploads", "loc-gone")).toBeUndefined();
    });
});

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function note(id: string, extra: Partial<LocalItem> = {}): LocalItem {
    return { ...uploadedItem(id), type: "note", chunk_set_id: null, ...extra } as LocalItem;
}

describe("upload-manager — terminal phases and resume", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
        await db.clear("items");
        startNewUploadMock.mockResolvedValue(uploadedItem("second-file-id"));
        resumeUploadMock.mockResolvedValue(uploadedItem("file-X"));
        pingOrExpireMock.mockResolvedValue("ok");
    });

    afterEach(async () => {
        for (const id of ["loc-a", "loc-b", "loc-c"]) {
            await abortPendingUpload(null, id).catch(() => {});
        }
    });

    // The catch used to write failed_recoverable over what the pipeline wrote.
    it("keeps orphan_committed that the pipeline wrote for an owner note in the Trash", async () => {
        const db = await getDB();
        const row = pending("loc-a", { chunk_set_id: "cs-x", phase: "paused", parent_id: "n1" });
        await db.put("pending-uploads", row);
        resumeUploadMock.mockImplementation(async () => {
            const cur = await db.get("pending-uploads", "loc-a");
            await db.put("pending-uploads", { ...cur!, phase: "orphan_committed" });
            throw new UploadPipelineError(
                "Owner note was deleted",
                "fatal_session",
                "failed_expired",
            );
        });

        await startUpload(null, row);

        expect((await db.get("pending-uploads", "loc-a"))?.phase).toBe("orphan_committed");
    });

    it("keeps failed_expired terminal — not resumed, not counted as work in flight", async () => {
        const db = await getDB();
        const row = pending("loc-a", { chunk_set_id: "cs-y", phase: "paused" });
        await db.put("pending-uploads", row);
        resumeUploadMock.mockImplementation(async () => {
            const cur = await db.get("pending-uploads", "loc-a");
            await db.put("pending-uploads", { ...cur!, phase: "failed_expired" });
            throw new UploadPipelineError(
                "Upload session expired",
                "fatal_session",
                "failed_expired",
            );
        });

        await startUpload(null, row);

        const after = await db.get("pending-uploads", "loc-a");
        expect(after?.phase).toBe("failed_expired");
        expect(shouldResumeOnStartup(after?.phase)).toBe(false);
        expect((await getUnsyncedWork()).uploadsActive).toBe(0);
    });

    it("a failure that says failed_expired is terminal even when the pipeline wrote nothing", async () => {
        const db = await getDB();
        const row = pending("loc-a", { chunk_set_id: "cs-z", phase: "uploading" });
        await db.put("pending-uploads", row);
        resumeUploadMock.mockRejectedValue(
            new UploadPipelineError("no_session", "fatal_session", "failed_expired"),
        );

        await startUpload(null, row);

        expect((await db.get("pending-uploads", "loc-a"))?.phase).toBe("failed_expired");
    });

    // A refusal the pipeline lets through as it is.
    it("an upload API refusal as malformed ends the session: failed_expired, so a Retry starts over", async () => {
        const db = await getDB();
        const row = pending("loc-a", { chunk_set_id: "cs-i", phase: "uploading" });
        await db.put("pending-uploads", row);
        resumeUploadMock.mockRejectedValue(
            new ApiError("bad_chunk_index", 400, { error: "bad_chunk_index", index: 7 }),
        );

        await startUpload(null, row);

        expect((await db.get("pending-uploads", "loc-a"))?.phase).toBe("failed_expired");
    });

    it("a file the server finds too large stays recoverable and names the server's limit", async () => {
        const db = await getDB();
        const row = pending("loc-a", { phase: "staging_source" });
        await db.put("pending-uploads", row);
        startNewUploadMock.mockRejectedValue(
            new ApiError("file_too_large", 413, {
                error: "file_too_large",
                max_file_size: 5 * 1024 * 1024,
            }),
        );

        await startUpload(null, row);

        const after = await db.get("pending-uploads", "loc-a");
        expect(after?.phase).toBe("failed_recoverable");
        expect(after?.last_error).toBe("Too large — the limit is 5 MB");
        expect(getUploadState("loc-a")?.error).toBe("Too large — the limit is 5 MB");
    });

    it("a row another tab has taken over is left as that tab wrote it", async () => {
        const db = await getDB();
        const row = pending("loc-a", { chunk_set_id: "cs-t", phase: "uploading" });
        await db.put("pending-uploads", row);
        resumeUploadMock.mockImplementation(async () => {
            const cur = await db.get("pending-uploads", "loc-a");
            await db.put("pending-uploads", {
                ...cur!,
                upload_lock: { tab_id: "other-tab", acquired_at: Date.now(), fence: 99 },
            });
            throw new UploadPipelineError(
                "Upload taken over by another tab",
                "fatal_session",
                "failed_expired",
            );
        });

        await startUpload(null, row);

        expect((await db.get("pending-uploads", "loc-a"))?.phase).toBe("uploading");
    });

    // Finalizing and committing_item started over used to mint a second file.
    it.each(["finalizing", "committing_item"] as const)(
        "a %s row continues its session under the same item id",
        async (phase) => {
            const db = await getDB();
            const row = pending("loc-a", { chunk_set_id: "cs-f", item_id: "file-f", phase });
            await db.put("pending-uploads", row);

            await startUpload(null, row);

            expect(startNewUploadMock).not.toHaveBeenCalled();
            expect(resumeUploadMock).toHaveBeenCalledOnce();
            expect(resumeUploadMock.mock.calls[0]?.[0]).toMatchObject({ item_id: "file-f" });
        },
    );

    it("a row that starts over keeps the item id it was given at opening_session", async () => {
        const db = await getDB();
        const row = pending("loc-a", { phase: "failed_recoverable", item_id: "file-r" });
        await db.put("pending-uploads", row);

        await startUpload(null, row);

        expect(startNewUploadMock).toHaveBeenCalledOnce();
        expect(startNewUploadMock.mock.calls[0]?.[2]).toMatchObject({ itemId: "file-r" });
    });

    // The note-open resume had no phase filter at all.
    it("opening the note leaves a `syncing` row to the reconciler — no second upload", async () => {
        const db = await getDB();
        await db.put("items", { ...uploadedItem("file-X"), parent_id: "note-1" });
        await db.put(
            "pending-uploads",
            pending("loc-a", {
                phase: "syncing",
                item_id: "file-X",
                chunk_set_id: "cs-1",
                note_id: "note-1",
                parent_id: "note-1",
            }),
        );

        await resumePendingUploads({ isDestroyed: true } as unknown as Editor, "note-1");
        await resumeAllPendingUploads();
        await settle();

        expect(startNewUploadMock).not.toHaveBeenCalled();
        expect(resumeUploadMock).not.toHaveBeenCalled();
    });

    it("an orphan_committed row waits while its owner note is in the Trash, and re-binds once it is back", async () => {
        const db = await getDB();
        await db.put("items", note("n1", { deleted_at: 100 }));
        await db.put(
            "pending-uploads",
            pending("loc-a", { phase: "orphan_committed", chunk_set_id: "cs-o", parent_id: "n1" }),
        );

        await resumeAllPendingUploads();
        await settle();
        expect(resumeUploadMock).not.toHaveBeenCalled();
        expect((await db.get("pending-uploads", "loc-a"))?.phase).toBe("orphan_committed");

        await db.put("items", note("n1", { deleted_at: null }));
        await reconcileOrphanUploads();
        await settle();
        expect(resumeUploadMock).toHaveBeenCalledOnce();
    });

    it("an orphan_committed row whose owner note is gone for good is released", async () => {
        const db = await getDB();
        await db.put(
            "pending-uploads",
            pending("loc-a", {
                phase: "orphan_committed",
                chunk_set_id: "cs-o",
                parent_id: "n-gone",
            }),
        );

        await resumeAllPendingUploads();
        await settle();

        expect(resumeUploadMock).not.toHaveBeenCalled();
        expect(await db.get("pending-uploads", "loc-a")).toBeUndefined();
    });

    // One failing ping used to reject the interval's promise and skip the rows after it.
    it("pingPausedUploads goes on past a row whose ping fails", async () => {
        const db = await getDB();
        await db.put(
            "pending-uploads",
            pending("loc-a", { phase: "paused", chunk_set_id: "cs-bad" }),
        );
        await db.put(
            "pending-uploads",
            pending("loc-b", { phase: "paused", chunk_set_id: "cs-gone" }),
        );
        pingOrExpireMock.mockImplementation(async (id: string) => {
            if (id === "cs-bad") throw new TypeError("Failed to fetch");
            return "expired";
        });

        await expect(pingPausedUploads()).resolves.toBeUndefined();

        expect(await db.get("pending-uploads", "loc-a")).toBeDefined();
        expect(await db.get("pending-uploads", "loc-b")).toBeUndefined();
    });
});

describe("upload-manager — the end of a removal grace and another tab's upload", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
    });

    it("leaves a row another tab is uploading: no row, staging or server session of its is removed", async () => {
        const db = await getDB();
        await db.put(
            "pending-uploads",
            pending("loc-b", {
                chunk_set_id: "cs-b",
                phase: "uploading",
                upload_lock: { tab_id: "other-tab", acquired_at: Date.now(), fence: 7 },
            }),
        );

        await abortRemovedUpload("loc-b");

        expect((await db.get("pending-uploads", "loc-b"))?.phase).toBe("uploading");
    });

    it("aborts a row no other tab holds, as before", async () => {
        const db = await getDB();
        await db.put("pending-uploads", pending("loc-own", { phase: "failed_recoverable" }));

        await abortRemovedUpload("loc-own");

        expect(await db.get("pending-uploads", "loc-own")).toBeUndefined();
    });
});

describe("upload-manager — an orphan_committed row with no source left", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
    });

    it("ends in failed_expired, which the sweep collects, instead of being retried on every change", async () => {
        const db = await getDB();
        const row = pending("loc-eph", {
            phase: "orphan_committed",
            storage_mode: "ephemeral",
            chunk_set_id: "cs-eph",
            item_id: "file-eph",
        });
        delete row.blob;
        await db.put("pending-uploads", row);

        await reconcileOrphanUploads();
        await reconcileOrphanUploads();

        expect(resumeUploadMock).not.toHaveBeenCalled();
        expect(startNewUploadMock).not.toHaveBeenCalled();
        expect((await db.get("pending-uploads", "loc-eph"))?.phase).toBe("failed_expired");
    });

    it("an orphan_committed row that still has its source is re-bound as before", async () => {
        const db = await getDB();
        const row = pending("loc-src", {
            phase: "orphan_committed",
            chunk_set_id: "cs-src",
            item_id: "file-src",
        });
        await db.put("pending-uploads", row);

        await reconcileOrphanUploads();
        await vi.waitFor(() => expect(resumeUploadMock).toHaveBeenCalledOnce());
    });
});

describe("upload-manager — an upload whose node the editor removed", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("pending-uploads");
        startNewUploadMock.mockResolvedValue(uploadedItem("file-done"));
    });

    it("a finish inside the grace swaps nothing and patches no stored note; an undo gets the file", async () => {
        const db = await getDB();
        const row = pending("rm-held", { note_id: "note-1", parent_id: "note-1" });
        await db.put("pending-uploads", row);
        holdRemovedUpload("rm-held");

        await startUpload(null, row);

        expect(swapFileRefMock).not.toHaveBeenCalled();
        expect(trashMock).not.toHaveBeenCalled();
        expect(releaseRemovedUpload("rm-held")).toBe("file-done");
    });

    it("a finish after the grace ran out, too late to stop, sends the file to the Trash", async () => {
        const db = await getDB();
        const row = pending("rm-late", { note_id: "note-1", parent_id: "note-1" });
        await db.put("pending-uploads", row);
        holdRemovedUpload("rm-late");
        expect(abandonRemovedUpload("rm-late")).toBeUndefined();

        await startUpload(null, row);

        expect(trashMock).toHaveBeenCalledWith("file-done");
        expect(swapFileRefMock).not.toHaveBeenCalled();
    });

    it("an upload nobody removed is placed as before", async () => {
        const db = await getDB();
        const row = pending("rm-none", { note_id: "note-1", parent_id: "note-1" });
        await db.put("pending-uploads", row);

        await startUpload(null, row);

        expect(swapFileRefMock).toHaveBeenCalledWith(
            "note-1",
            "local:rm-none",
            "file-done",
            undefined,
        );
        expect(trashMock).not.toHaveBeenCalled();
    });
});

// The page died between the editor's swap and its save of it (a reload, a closed or killed tab): the
// stored note still holds `local:<id>`, and the row is the only record of which file that became.
describe("upload-manager — a `syncing` row points its note at the file before it goes", () => {
    const completions: unknown[] = [];
    const onComplete = (e: Event) => completions.push((e as CustomEvent).detail);

    beforeEach(async () => {
        vi.clearAllMocks();
        completions.length = 0;
        window.addEventListener(APP_EVENTS.uploadComplete, onComplete);
        const db = await getDB();
        await db.clear("pending-uploads");
        await db.clear("items");
    });

    afterEach(() => {
        window.removeEventListener(APP_EVENTS.uploadComplete, onComplete);
    });

    async function syncingRow(localId: string, fileId: string, dirty: boolean): Promise<void> {
        const db = await getDB();
        await db.put("items", { ...uploadedItem(fileId), dirty });
        await db.put(
            "pending-uploads",
            pending(localId, {
                phase: "syncing",
                item_id: fileId,
                note_id: "note-1",
                chunk_set_id: "cs-1",
            }),
        );
    }

    it("repoints the stored note while the row still exists, then releases it", async () => {
        await syncingRow("loc-r1", "file-r1", false);
        const db = await getDB();
        const rowsAtRepoint: unknown[] = [];
        swapFileRefMock.mockImplementationOnce(async () => {
            rowsAtRepoint.push(await db.get("pending-uploads", "loc-r1"));
            return true;
        });

        expect(await reconcileSyncingUploads()).toBe(1);

        expect(swapFileRefMock).toHaveBeenCalledWith("note-1", "local:loc-r1", "file-r1", 1);
        expect(rowsAtRepoint[0]).toBeDefined();
        expect(await db.get("pending-uploads", "loc-r1")).toBeUndefined();
        // An editor showing the note still holds the `local:` node — the note page swaps it.
        expect(completions).toEqual([
            { localId: "local:loc-r1", fileId: "file-r1", noteId: "note-1" },
        ]);
    });

    it("repoints before the push is acknowledged, and only once", async () => {
        await syncingRow("loc-r2", "file-r2", true);

        expect(await reconcileSyncingUploads()).toBe(0);
        expect(await reconcileSyncingUploads()).toBe(0);

        expect(swapFileRefMock).toHaveBeenCalledTimes(1);
        expect(await (await getDB()).get("pending-uploads", "loc-r2")).toBeDefined();
    });

    it("a note that no longer stores the ref is left alone, and the editor is not told", async () => {
        await syncingRow("loc-r3", "file-r3", false);
        swapFileRefMock.mockResolvedValueOnce(false);

        expect(await reconcileSyncingUploads()).toBe(1);

        expect(completions).toEqual([]);
    });

    it("a note that could not be written keeps the row, and the next reconcile tries again", async () => {
        await syncingRow("loc-r4", "file-r4", false);
        swapFileRefMock.mockRejectedValueOnce(new Error("IDB write failed"));

        expect(await reconcileSyncingUploads()).toBe(0);
        expect(await (await getDB()).get("pending-uploads", "loc-r4")).toBeDefined();

        expect(await reconcileSyncingUploads()).toBe(1);
        expect(swapFileRefMock).toHaveBeenCalledTimes(2);
        expect(await (await getDB()).get("pending-uploads", "loc-r4")).toBeUndefined();
    });
});
