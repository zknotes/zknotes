import type { QueryClient } from "@tanstack/svelte-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pendingFileIdsArr: string[] = [];

vi.mock("$lib/modules/files/pending-trash", () => ({
    pendingTrashManager: {
        get pendingFileIds() {
            return pendingFileIdsArr;
        },
    },
}));

vi.mock("$lib/core/services/item-service", () => ({
    ItemService: {
        updateItemPayload: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock("$lib/core/sync/history", () => ({
    maybeCreateSnapshot: vi.fn().mockResolvedValue(undefined),
}));

import { NoteAutosave } from "./NoteAutosave.svelte";

function mockQueryClient(): QueryClient {
    return {
        setQueryData: vi.fn(),
        invalidateQueries: vi.fn(() => Promise.resolve()),
    } as unknown as QueryClient;
}

describe("NoteAutosave", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        pendingFileIdsArr.length = 0;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("autosave reschedules after a skipped save", () => {
        const mockEditor = {
            isDestroyed: false,
            getHTML: () => "<p>test</p>",
            state: {
                doc: {
                    descendants: (cb: (node: unknown) => boolean | void) => {
                        cb({ isText: true, text: "test" });
                    },
                },
            },
        };

        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

        const autosave = new NoteAutosave(
            mockQueryClient(),
            () => mockEditor as any,
            () => "note-1",
        );

        // Step 1: Active pending trash blocks executeSave
        pendingFileIdsArr.push("file-1");

        // First markDirty schedules a timer
        autosave.markDirty();
        expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

        // Step 2: Let the idle timer fire (10 s after the keystroke)
        vi.advanceTimersByTime(10 * 1000);

        // Step 3: Pending trash resolves
        pendingFileIdsArr.length = 0;

        // Step 4: markDirty is called again
        autosave.markDirty();

        // Must schedule a new timer (2nd setTimeout call)
        expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    });
});
