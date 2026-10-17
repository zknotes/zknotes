/**
 * The Sync activity panel's status line says which half of the sync runs, and the empty Pending
 * changes list speaks about the queue only. A note save goes straight to the server past the queue,
 * so "Syncing…" over "Nothing waiting — everything is synced." read as a contradiction.
 */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/core/db", () => ({
    getDB: vi.fn().mockResolvedValue({
        getAll: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(undefined),
    }),
    getPendingMutationCount: vi.fn().mockResolvedValue(0),
}));
vi.mock("$lib/core/sync/unsynced-work", () => ({
    getUnsyncedWork: vi.fn().mockResolvedValue({ failedCount: 0 }),
}));
vi.mock("$lib/core/sync/engine", () => ({
    clearSyncErrorsAndRequeue: vi.fn(),
    mutationRetryAt: vi.fn().mockReturnValue(0),
    pushPendingMutations: vi.fn(),
}));
vi.mock("$lib/core/crypto/item-codec", () => ({ decryptItemPayload: vi.fn() }));
vi.mock("$lib/modules/files/upload", () => ({ computeUploadDisplayPct: vi.fn() }));
vi.mock("$lib/modules/files/upload-manager", () => ({
    subscribeAllUploads: vi.fn().mockReturnValue(() => {}),
    getAllUploadStates: vi.fn().mockReturnValue(new Map()),
}));

const { syncStore } = await import("$lib/core/sync/store.svelte");
const { default: SyncPanel } = await import("./SyncPanel.svelte");

let target: HTMLElement | undefined;
let instance: Record<string, unknown> | undefined;
const cleanups: Array<() => void> = [];

afterEach(() => {
    if (instance) unmount(instance);
    instance = undefined;
    target?.remove();
    target = undefined;
    for (const cleanup of cleanups.splice(0)) cleanup();
});

async function render(): Promise<HTMLElement> {
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(SyncPanel, { target, props: { open: true, onClose: () => {} } });
    // loadPending reads the (mocked) queue asynchronously.
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    return target;
}

function panelText(root: HTMLElement): string {
    return root.textContent?.replace(/\s+/g, " ") ?? "";
}

describe("SyncPanel status and empty queue", () => {
    it("a note save in flight reads 'Sending changes…', and the empty queue claims nothing more", async () => {
        syncStore.beginPush();
        cleanups.push(() => syncStore.endPush());
        const root = await render();

        const text = panelText(root);
        expect(text).toContain("Sending changes…");
        expect(text).toContain("Nothing waiting to be sent.");
        expect(text).not.toContain("everything is synced");
    });

    it("a cycle with nothing to push reads as a check for other devices' changes", async () => {
        syncStore.startSync();
        cleanups.push(() => syncStore.endSync());
        const root = await render();

        expect(panelText(root)).toContain("Checking for changes from other devices…");
    });

    it("a push outranks the pull within one cycle", async () => {
        syncStore.startSync();
        syncStore.beginPush();
        cleanups.push(() => {
            syncStore.endPush();
            syncStore.endSync();
        });
        const root = await render();

        expect(panelText(root)).toContain("Sending changes…");
    });

    it("idle: the status line carries 'All changes saved', the list only its own state", async () => {
        const root = await render();

        const text = panelText(root);
        expect(text).toContain("All changes saved");
        expect(text).toContain("Nothing waiting to be sent.");
    });

    it("unsaved edits over an empty queue do not read as 'everything is synced'", async () => {
        cleanups.push(syncStore.registerUnsavedEdits(() => true));
        const root = await render();

        const text = panelText(root);
        expect(text).toContain("Unsaved edits in the open note");
        expect(text).not.toContain("everything is synced");
    });
});
