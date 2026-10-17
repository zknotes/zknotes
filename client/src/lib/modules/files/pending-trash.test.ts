import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { trashMock } = vi.hoisted(() => ({
    trashMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./file-service", () => ({
    FileService: { trash: trashMock },
}));

const { abortPendingUploadMock } = vi.hoisted(() => ({
    abortPendingUploadMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./upload-manager", () => ({
    abortRemovedUpload: (localId: string) => abortPendingUploadMock(null, localId),
}));

vi.mock("$lib/core/stores/toast.svelte", () => ({
    globalToasts: {
        add: vi.fn(() => "toast-1"),
        remove: vi.fn(),
    },
}));

import type { Editor } from "@tiptap/core";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { PENDING_TRASH_GRACE_MS, pendingTrashManager } from "./pending-trash";
import { placeFinishedUpload } from "./removed-uploads";

const editor = {
    commands: { undo: vi.fn() },
} as unknown as Editor;

describe("PendingTrashManager", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        trashMock.mockClear();
        abortPendingUploadMock.mockClear();
        pendingTrashManager.cancelAll();
        vi.mocked(globalToasts.add).mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
        pendingTrashManager.cancelAll();
    });

    it("schedule → cancel → trash is never called", () => {
        pendingTrashManager.schedule("file-1", "note-1", editor);
        expect(pendingTrashManager.isPending("file-1")).toBe(true);
        pendingTrashManager.cancel("file-1");
        vi.advanceTimersByTime(PENDING_TRASH_GRACE_MS + 100);
        expect(trashMock).not.toHaveBeenCalled();
    });

    it("schedule → the timer expires → trash", async () => {
        pendingTrashManager.schedule("file-1", "note-1", editor);
        vi.advanceTimersByTime(PENDING_TRASH_GRACE_MS);
        await Promise.resolve();
        expect(trashMock).toHaveBeenCalledWith("file-1");
        expect(pendingTrashManager.isPending("file-1")).toBe(false);
    });

    it("commitAll trashes everything pending at once", async () => {
        pendingTrashManager.schedule("file-a", "note-1", editor);
        pendingTrashManager.schedule("file-b", "note-1", editor);
        await pendingTrashManager.commitAll();
        expect(trashMock).toHaveBeenCalledTimes(2);
        expect(pendingTrashManager.pendingFileIds).toEqual([]);
    });

    // An upload still running gets the same grace and toast, then an abort instead of the Trash.
    it("a local: upload waits out the same grace, then is aborted — never trashed", async () => {
        pendingTrashManager.schedule("local:abc", "note-1", editor);
        expect(pendingTrashManager.pendingFileIds).toEqual(["local:abc"]);
        expect(globalToasts.add).toHaveBeenCalledWith(
            expect.objectContaining({
                message: "File removed.",
                durationMs: PENDING_TRASH_GRACE_MS,
            }),
        );

        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);

        expect(abortPendingUploadMock).toHaveBeenCalledWith(null, "abc");
        expect(trashMock).not.toHaveBeenCalled();
        expect(pendingTrashManager.isPending("local:abc")).toBe(false);
    });

    it("a local: upload that finished inside the grace sends its file to the Trash", async () => {
        pendingTrashManager.schedule("local:done", "note-1", editor);
        expect(placeFinishedUpload("done", "file-real")).toBe("hold");

        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);

        expect(trashMock).toHaveBeenCalledWith("file-real");
        expect(abortPendingUploadMock).not.toHaveBeenCalled();
    });

    it("a finish after the grace ran out, too late to stop, is sent to the Trash", async () => {
        pendingTrashManager.schedule("local:late", "note-1", editor);
        await vi.advanceTimersByTimeAsync(PENDING_TRASH_GRACE_MS);
        expect(abortPendingUploadMock).toHaveBeenCalledWith(null, "late");

        expect(placeFinishedUpload("late", "file-late")).toBe("trash");
        expect(placeFinishedUpload("unrelated", "file-x")).toBe("place");
    });

    it("leaving the note says an aborted upload was removed, not moved to the Trash", async () => {
        pendingTrashManager.schedule("local:nav", "note-1", editor);
        vi.mocked(globalToasts.add).mockClear();

        await pendingTrashManager.commitAll({ navigateAway: true });

        expect(globalToasts.add).toHaveBeenCalledWith(
            expect.objectContaining({ message: "File removed." }),
        );
        expect(abortPendingUploadMock).toHaveBeenCalledWith(null, "nav");
    });
});
