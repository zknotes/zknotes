/**
 * HistoryPanel decrypts every snapshot as the note it is showing, never as the item id the server
 * put on the snapshot: another note's snapshot listed in this note's history is neither previewed
 * nor restored into it. The real AAD refusal is proven in core/sync/history.integration.test.ts;
 * here the codec is a stand-in with the same rule (a ciphertext opens only under the id it was
 * sealed for), so the test pins the panel's wiring.
 * Environment: vitest project `dom` (jsdom).
 */
import type { HistorySnapshot, NotePayload } from "@zknotes/shared";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sealed, listSnapshots, decryptItemPayload, updateItemPayload } = vi.hoisted(() => {
    const sealed = new Map<string, { itemId: string; payload: NotePayload }>();
    return {
        sealed,
        listSnapshots: vi.fn(),
        decryptItemPayload: vi.fn(
            async (item: { id: string; encrypted_payload?: string | null }) => {
                const box = sealed.get(item.encrypted_payload ?? "");
                if (!box || box.itemId !== item.id) throw new Error("invalid tag");
                return box.payload;
            },
        ),
        updateItemPayload: vi.fn(async () => {}),
    };
});

vi.mock("@tanstack/svelte-query", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@tanstack/svelte-query")>()),
    useQueryClient: () => ({ getQueryData: () => [], invalidateQueries: async () => {} }),
}));
vi.mock("$lib/core/api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("$lib/core/api")>()),
    listSnapshots,
}));
vi.mock("$lib/core/crypto/item-codec", () => ({ decryptItemPayload }));
vi.mock("$lib/core/services/item-service", () => ({ ItemService: { updateItemPayload } }));
vi.mock("$lib/core/sync/history", async (importOriginal) => ({
    ...(await importOriginal<typeof import("$lib/core/sync/history")>()),
    maybeCreateSnapshot: vi.fn(async () => {}),
}));

import HistoryPanel from "./HistoryPanel.svelte";

const NOTE_A = "0192f000-0000-7000-8000-00000000000a";
const NOTE_B = "0192f000-0000-7000-8000-00000000000b";

/** A snapshot whose (stand-in) ciphertext opens only under `itemId`, as the payload AAD does. */
function snapshotOf(itemId: string, text: string, n: number): HistorySnapshot {
    const ciphertext = `ciphertext-${itemId}-${n}`;
    sealed.set(ciphertext, {
        itemId,
        payload: { title: text, contentTitle: text, content: `<p>${text}</p>` },
    });
    return {
        id: `0192f000-0000-7000-9000-${String(n).padStart(12, "0")}`,
        item_id: itemId,
        encrypted_payload: ciphertext,
        payload_nonce: "nonce",
        encrypted_item_key: "wrapped-item-key",
        item_key_nonce: "item-key-nonce",
        item_version_at_snapshot: n,
        snapshot_number: n,
        created_at: 1_700_000_000 + n,
    };
}

let target: HTMLElement | undefined;
let instance: ReturnType<typeof mount> | undefined;

async function renderPanel(noteId: string, snapshots: HistorySnapshot[]): Promise<HTMLElement> {
    listSnapshots.mockResolvedValue({ snapshots, total: snapshots.length });
    const root = document.createElement("div");
    document.body.appendChild(root);
    target = root;
    instance = mount(HistoryPanel, {
        target: root,
        props: { noteId, editor: undefined, visible: true },
    });
    flushSync();
    await vi.waitFor(() =>
        expect(root.querySelectorAll('[role="option"]')).toHaveLength(snapshots.length),
    );
    return root;
}

function rowRestoreButton(root: HTMLElement): HTMLButtonElement {
    const button = root.querySelector<HTMLButtonElement>('button[title="Restore this version"]');
    if (!button) throw new Error("row restore button not found");
    return button;
}

/** Lets the click handler's promise chain run to the end. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
}

function codecIds(): string[] {
    return decryptItemPayload.mock.calls.map(([item]) => item.id);
}

beforeEach(() => {
    sealed.clear();
    listSnapshots.mockReset();
    decryptItemPayload.mockClear();
    updateItemPayload.mockClear();
});

afterEach(() => {
    if (instance) unmount(instance);
    instance = undefined;
    target?.remove();
    target = undefined;
});

describe("HistoryPanel — snapshots are bound to the note being viewed", () => {
    it("does not preview another note's snapshot listed in this note's history", async () => {
        const root = await renderPanel(NOTE_A, [snapshotOf(NOTE_B, "B, never meant for A", 1)]);

        root.querySelector<HTMLElement>('[role="option"]')?.click();
        await vi.waitFor(() => expect(root.textContent).toContain("Could not decrypt snapshot."));

        expect(root.textContent).not.toContain("B, never meant for A");
        expect(codecIds().every((id) => id === NOTE_A)).toBe(true);
    });

    it("does not restore another note's snapshot into this note", async () => {
        const root = await renderPanel(NOTE_A, [snapshotOf(NOTE_B, "B, never meant for A", 1)]);

        rowRestoreButton(root).click();
        await settle();

        expect(updateItemPayload).not.toHaveBeenCalled();
        expect(codecIds().every((id) => id === NOTE_A)).toBe(true);
    });

    it("previews and restores the note's own snapshot under the note's id", async () => {
        const root = await renderPanel(NOTE_A, [snapshotOf(NOTE_A, "A, two versions ago", 2)]);

        root.querySelector<HTMLElement>('[role="option"]')?.click();
        await vi.waitFor(() =>
            expect(root.querySelector(".ProseMirror")?.textContent).toBe("A, two versions ago"),
        );
        const restore = [...root.querySelectorAll("button")].find(
            (b) => b.textContent?.trim() === "Restore this version",
        );
        restore?.click();

        await vi.waitFor(() =>
            expect(updateItemPayload).toHaveBeenCalledWith(
                NOTE_A,
                "A, two versions ago",
                "<p>A, two versions ago</p>",
            ),
        );
        expect(codecIds()).toEqual([NOTE_A]);
    });
});
