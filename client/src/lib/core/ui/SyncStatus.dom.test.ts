/**
 * The sync chip: unsaved editor edits and pushes in flight reach the chip, and the
 * state priority is offline > syncing > error > unsaved > pending > idle.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { syncStore } from "$lib/core/sync/store.svelte";
import SyncStatus from "./SyncStatus.svelte";
import SyncStatusTestHost from "./SyncStatus.test-host.svelte";

let target: HTMLElement | undefined;
let instance: Record<string, unknown> | undefined;
const cleanups: Array<() => void> = [];

afterEach(() => {
    if (instance) unmount(instance);
    instance = undefined;
    target?.remove();
    target = undefined;
    for (const cleanup of cleanups.splice(0)) cleanup();
    syncStore.setOnline(true);
});

function render(): HTMLElement {
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(SyncStatus, { target, props: {} });
    flushSync();
    return target;
}

function chipText(root: HTMLElement): string {
    return root.querySelector("[data-testid=sync-status]")?.textContent?.trim() ?? "";
}

function withUnsavedEdits(): void {
    cleanups.push(syncStore.registerUnsavedEdits(() => true));
}

function withPushInFlight(): void {
    syncStore.beginPush();
    cleanups.push(() => syncStore.endPush());
}

describe("SyncStatus", () => {
    it("shows 'Unsaved changes' while the open note holds unsaved edits", () => {
        const root = render();
        expect(chipText(root)).toBe("All changes saved");

        withUnsavedEdits();
        flushSync();
        expect(chipText(root)).toBe("Unsaved changes");
    });

    it("offline outranks unsaved edits", () => {
        const root = render();
        withUnsavedEdits();
        syncStore.setOnline(false);
        flushSync();
        expect(chipText(root)).toBe("Offline");
    });

    it("a push in flight shows 'Syncing…', even with unsaved edits", () => {
        const root = render();
        withUnsavedEdits();
        withPushInFlight();
        flushSync();
        expect(chipText(root)).toBe("Syncing…");

        syncStore.endPush();
        cleanups.pop();
        flushSync();
        expect(chipText(root)).toBe("Unsaved changes");
    });

    it("a source registered from an $effect does not loop, and follows the editor's state", () => {
        target = document.createElement("div");
        document.body.appendChild(target);
        const host = mount(SyncStatusTestHost, { target, props: {} }) as {
            setDirty(v: boolean): void;
        };
        instance = host as unknown as Record<string, unknown>;
        flushSync();
        expect(chipText(target)).toBe("Unsaved changes");

        host.setDirty(false);
        flushSync();
        expect(chipText(target)).toBe("All changes saved");
        expect(syncStore.hasUnsavedEdits).toBe(false);
    });
});
