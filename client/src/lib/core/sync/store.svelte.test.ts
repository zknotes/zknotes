import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/core/db", () => ({ getPendingMutationCount: vi.fn().mockResolvedValue(0) }));
vi.mock("./unsynced-work", () => ({
    getUnsyncedWork: vi.fn().mockResolvedValue({ failedCount: 0 }),
}));

// A fresh store per test — the module exports a singleton.
async function freshStore() {
    vi.resetModules();
    return (await import("./store.svelte")).syncStore;
}

describe("syncStore.isSyncing — the cycle plus pushes in flight", () => {
    it("is true while the scheduler's cycle runs", async () => {
        const store = await freshStore();
        expect(store.isSyncing).toBe(false);
        store.startSync();
        expect(store.isSyncing).toBe(true);
        store.endSync();
        expect(store.isSyncing).toBe(false);
    });

    it("is true while any push is in flight, outside a cycle as well", async () => {
        const store = await freshStore();
        store.beginPush();
        store.beginPush();
        store.endPush();
        expect(store.isSyncing).toBe(true);
        store.endPush();
        expect(store.isSyncing).toBe(false);
    });

    it("a stray endPush never drives the counter below zero", async () => {
        const store = await freshStore();
        store.endPush();
        store.endPush();
        store.beginPush();
        expect(store.isSyncing).toBe(true);
        store.endPush();
        expect(store.isSyncing).toBe(false);
    });

    it("isPushing counts the pushes only — a cycle's pull alone is not a push", async () => {
        const store = await freshStore();
        store.startSync();
        expect(store.isSyncing).toBe(true);
        expect(store.isPushing).toBe(false);
        store.beginPush();
        expect(store.isPushing).toBe(true);
        store.endPush();
        store.endSync();
        expect(store.isPushing).toBe(false);
    });

    it("ending the cycle leaves a push that is still in flight visible", async () => {
        const store = await freshStore();
        store.startSync();
        store.beginPush();
        store.endSync();
        expect(store.isSyncing).toBe(true);
        store.endPush();
        expect(store.isSyncing).toBe(false);
    });
});

describe("syncStore.hasUnsavedEdits — registered sources", () => {
    it("is false with no source, and follows a registered getter", async () => {
        const store = await freshStore();
        expect(store.hasUnsavedEdits).toBe(false);

        let dirty = false;
        const unregister = store.registerUnsavedEdits(() => dirty);
        expect(store.hasUnsavedEdits).toBe(false);
        dirty = true;
        expect(store.hasUnsavedEdits).toBe(true);

        unregister();
        expect(store.hasUnsavedEdits).toBe(false);
    });

    it("is true when any one of several sources reports unsaved edits", async () => {
        const store = await freshStore();
        const offA = store.registerUnsavedEdits(() => false);
        const offB = store.registerUnsavedEdits(() => true);
        expect(store.hasUnsavedEdits).toBe(true);
        offB();
        expect(store.hasUnsavedEdits).toBe(false);
        offA();
    });
});
