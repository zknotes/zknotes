import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    encryptPayloadWithNewKeyTask,
    encryptItemPayloadToBase64,
    decryptItemPayload,
    createLocalConflictCopyFromPayload,
    replaceConflictCopyContent,
    conflictStoreAdd,
    toastAdd,
    isVaultSessionCurrent,
} = vi.hoisted(() => ({
    encryptPayloadWithNewKeyTask: vi.fn(),
    encryptItemPayloadToBase64: vi.fn(),
    decryptItemPayload: vi.fn(),
    createLocalConflictCopyFromPayload: vi.fn(),
    replaceConflictCopyContent: vi.fn(),
    conflictStoreAdd: vi.fn(),
    toastAdd: vi.fn(),
    // The session-generation belt — true by default (a normal session); individual tests override
    // it to false to prove the fail-closed behaviour without meddling with the real
    // localStorage/sessionStorage.
    isVaultSessionCurrent: vi.fn().mockReturnValue(true),
}));

vi.mock("$lib/core/api", () => ({ pushBatch: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/core/crypto/session-key", () => ({ isVaultSessionCurrent }));
vi.mock("$lib/core/sync", () => {
    const pushItem = vi.fn().mockResolvedValue(undefined);
    return {
        pushItem,
        // The service pushes through pushOrQueue; the assertions below still count pushItem calls.
        pushOrQueue: vi.fn((item: unknown) => {
            void pushItem(item);
        }),
        pushDeletes: vi.fn().mockResolvedValue(undefined),
        enqueueMutation: vi.fn().mockResolvedValue(undefined),
    };
});
vi.mock("$lib/core/events/file-bridge", () => ({
    fileBridge: { invalidateFile: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("$lib/core/sync/conflict", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    createLocalConflictCopyFromPayload,
    replaceConflictCopyContent,
}));
vi.mock("$lib/core/stores/conflict-store.svelte", () => ({
    conflictStore: { add: conflictStoreAdd },
}));
vi.mock("$lib/core/stores/toast.svelte", () => ({
    globalToasts: { add: toastAdd },
}));
vi.mock("$lib/core/search", () => ({
    addOrUpdateDoc: vi.fn().mockResolvedValue(undefined),
    removeDoc: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/core/workers/crypto-rpc", () => ({
    encryptPayloadWithNewKeyTask,
}));
vi.mock("$lib/core/crypto/item-codec", () => ({
    decryptItemPayload,
    encryptItemPayloadToBase64,
}));

import { getDB, type LocalItem } from "$lib/core/db";
import { addOrUpdateDoc } from "$lib/core/search";
import { pushItem } from "$lib/core/sync";
import { ConcurrentEditConflictError, ItemService, SessionExpiredError } from "./item-service";

const pushItemMock = vi.mocked(pushItem);
const addOrUpdateDocMock = vi.mocked(addOrUpdateDoc);
const isVaultSessionCurrentMock = vi.mocked(isVaultSessionCurrent);

async function seed(over: Partial<LocalItem> & { id: string; type: LocalItem["type"] }) {
    const db = await getDB();
    await db.put("items", {
        parent_id: null,
        encrypted_payload: "old-enc",
        payload_nonce: "old-nonce",
        encrypted_item_key: "ik",
        item_key_nonce: "ikn",
        version: 2,
        sort_order: over.id,
        dirty: false,
        localRev: 1,
        ...over,
    } as LocalItem);
}

beforeEach(async () => {
    vi.clearAllMocks();
    const db = await getDB();
    await db.clear("items");
    encryptPayloadWithNewKeyTask.mockResolvedValue({
        encryptedItemKey: new Uint8Array([1]),
        itemKeyNonce: new Uint8Array([2]),
        ciphertext: new Uint8Array([3]),
        nonce: new Uint8Array([4]),
    });
    encryptItemPayloadToBase64.mockResolvedValue({
        encrypted_payload: "new-enc",
        payload_nonce: "new-nonce",
    });
    decryptItemPayload.mockResolvedValue({
        title: "Original",
        contentTitle: "Original",
        content: "<p>body</p>",
        starred: false,
    });
});

describe("ItemService.createItem", () => {
    it("creates encrypted note in IDB and schedules push", async () => {
        const item = await ItemService.createItem("note", null, "My Note");

        expect(item.type).toBe("note");
        expect(item.version).toBe(1);
        expect(item.dirty).toBe(true);
        expect(item.encrypted_payload).toBeTruthy();
        expect(await (await getDB()).get("items", item.id)).toEqual(item);
        expect(pushItemMock).toHaveBeenCalledWith(item);
        expect(addOrUpdateDocMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: item.id, type: "note", title: "My Note" }),
        );
    });

    it("note payload carries content/contentTitle/starred; folder payload does not", async () => {
        await ItemService.createItem("note", null, "My Note");
        expect(encryptPayloadWithNewKeyTask).toHaveBeenLastCalledWith(
            expect.any(String),
            { title: "My Note", contentTitle: "My Note", content: "", starred: false },
            1,
        );

        await ItemService.createItem("folder", null, "My Folder");
        // A FolderPayload has no content/contentTitle — writing them would be dead weight inside the
        // ciphertext that a backup round trip could not reproduce (folder.ts/full-backup.ts).
        expect(encryptPayloadWithNewKeyTask).toHaveBeenLastCalledWith(
            expect.any(String),
            { title: "My Folder", starred: false },
            1,
        );
    });

    // Another user signing in to this browser rotates the session generation; this
    // tab must not create (and push) a new row under someone else's cookie.
    it("refuses to create item when vault session is no longer current", async () => {
        isVaultSessionCurrentMock.mockReturnValueOnce(false);

        await expect(ItemService.createItem("note", null, "My Note")).rejects.toThrow(
            SessionExpiredError,
        );

        // Nothing written and nothing pushed — the check comes before the key generation and the IDB write.
        expect(encryptPayloadWithNewKeyTask).not.toHaveBeenCalled();
        expect(pushItemMock).not.toHaveBeenCalled();
    });
});

describe("ItemService.updateItemTitle", () => {
    it("re-encrypts payload and bumps localRev", async () => {
        await seed({ id: "note-1", type: "note" });

        await ItemService.updateItemTitle("note-1", "Renamed");

        const stored = await (await getDB()).get("items", "note-1");
        expect(stored?.encrypted_payload).toBe("new-enc");
        expect(stored?.dirty).toBe(true);
        expect(stored?.localRev).toBe(2);
        expect(pushItemMock).toHaveBeenCalled();
    });
});

describe("ItemService.reencryptAndSave — a mutate with nothing to change", () => {
    it("returns the item as it is, with no write and no push", async () => {
        await seed({ id: "note-1", type: "note" });
        const db = await getDB();
        const before = await db.get("items", "note-1");

        const result = await ItemService.reencryptAndSave("note-1", () => null);

        expect(result).toEqual(before);
        expect(await db.get("items", "note-1")).toEqual(before);
        expect(encryptItemPayloadToBase64).not.toHaveBeenCalled();
        expect(pushItemMock).not.toHaveBeenCalled();
    });
});

describe("ItemService.duplicateItem", () => {
    it("creates copy of note with copied content", async () => {
        await seed({ id: "note-src", type: "note", sort_order: "a" });

        const { item: copy, strippedAttachments } = await ItemService.duplicateItem("note-src");

        expect(copy.type).toBe("note");
        expect(copy.id).not.toBe("note-src");
        expect(copy.parent_id).toBeNull();
        expect(strippedAttachments).toBe(0);
        expect(encryptItemPayloadToBase64).toHaveBeenCalled();
        expect(await (await getDB()).get("items", copy.id)).toBeDefined();
    });

    it("strips encFile refs from duplicated note content", async () => {
        await seed({ id: "note-src", type: "note", sort_order: "a" });
        decryptItemPayload.mockResolvedValueOnce({
            title: "With image",
            contentTitle: "With image",
            content: '<p>intro</p><img data-file-id="file-abc" alt="pic.jpg" /><p>outro</p>',
        });

        const { strippedAttachments } = await ItemService.duplicateItem("note-src");

        expect(strippedAttachments).toBe(1);
        const encryptCall = encryptItemPayloadToBase64.mock.calls.at(-1)?.[2] as {
            content?: string;
        };
        expect(encryptCall?.content).not.toContain("data-file-id");
        expect(encryptCall?.content).toContain("intro");
        expect(encryptCall?.content).toContain("outro");
    });

    it("rejects duplicating file items", async () => {
        await seed({ id: "file-1", type: "file" });
        decryptItemPayload.mockResolvedValueOnce({
            kind: "file",
            title: "doc.pdf",
            chunkSetId: "cs-1",
        });

        await expect(ItemService.duplicateItem("file-1")).rejects.toThrow(
            "Cannot duplicate a file",
        );
    });
});

describe("ItemService multi-tab basedOnContent", () => {
    it("saves when IDB still matches editor baseline", async () => {
        await seed({ id: "note-1", type: "note" });
        decryptItemPayload.mockResolvedValue({
            title: "N",
            contentTitle: "N",
            content: "<p>BASE</p>",
            starred: false,
        });

        await ItemService.updateItemPayload("note-1", "N", "<p>EMPTY</p>", {
            basedOnContent: "<p>BASE</p>",
        });

        expect(createLocalConflictCopyFromPayload).not.toHaveBeenCalled();
        expect(encryptItemPayloadToBase64).toHaveBeenCalled();
    });

    it("creates conflict copy when IDB diverged from baseline and from next write", async () => {
        await seed({ id: "note-1", type: "note" });
        decryptItemPayload.mockResolvedValue({
            title: "N",
            contentTitle: "N",
            content: "<p>FROM OTHER TAB</p>",
            starred: false,
        });
        createLocalConflictCopyFromPayload.mockResolvedValue({
            item: {
                id: "copy-1",
                type: "note",
                parent_id: null,
                encrypted_payload: "c",
                payload_nonce: "n",
                encrypted_item_key: "ik",
                item_key_nonce: "ikn",
                version: 1,
                dirty: true,
                sort_order: "copy-1",
                conflict_of: "note-1",
            } satisfies LocalItem,
            title: "N [Conflict]",
        });

        await expect(
            ItemService.updateItemPayload("note-1", "N", "<p>FROM THIS TAB</p>", {
                basedOnContent: "<p>BASE</p>",
            }),
        ).rejects.toBeInstanceOf(ConcurrentEditConflictError);

        expect(createLocalConflictCopyFromPayload).toHaveBeenCalledOnce();
        expect(conflictStoreAdd).toHaveBeenCalled();
        // Original note must NOT be overwritten with this tab's content
        expect(encryptItemPayloadToBase64).not.toHaveBeenCalled();
    });

    it("same-tab intermediate write (file strip): getter baseline advances → no false conflict", async () => {
        await seed({ id: "note-1", type: "note" });
        // Simulates the race: a trash strips the refs in IDB (BASE → STRIPPED), the event moves the
        // baseline, then an autosave of the empty editor reads that baseline inside the lock.
        let base = "<p>BASE with file</p>";
        decryptItemPayload
            .mockResolvedValueOnce({
                title: "N",
                contentTitle: "N",
                content: "<p>BASE with file</p>",
                starred: false,
            })
            .mockResolvedValueOnce({
                title: "N",
                contentTitle: "N",
                content: "<p>STRIPPED</p>",
                starred: false,
            });

        // 1) A same-tab strip write (with no basedOnContent) — like removeFileRefsFromNotes
        await ItemService.updateItemPayload("note-1", "N", "<p>STRIPPED</p>");
        base = "<p>STRIPPED</p>"; // the noteContentWritten listener in the real UI

        // 2) An editor save of empty content with a getter (the way NoteAutosave does it)
        await ItemService.updateItemPayload("note-1", "N", "<p></p>", {
            basedOnContent: () => base,
        });

        expect(createLocalConflictCopyFromPayload).not.toHaveBeenCalled();
        expect(encryptItemPayloadToBase64).toHaveBeenCalledTimes(2);
    });

    it("accepts save when stored already equals next (no need for conflict)", async () => {
        await seed({ id: "note-1", type: "note" });
        decryptItemPayload.mockResolvedValue({
            title: "N",
            contentTitle: "N",
            content: "<p>SAME</p>",
            starred: false,
        });

        await ItemService.updateItemPayload("note-1", "N", "<p>SAME</p>", {
            basedOnContent: "<p>OLD BASE</p>",
        });

        expect(createLocalConflictCopyFromPayload).not.toHaveBeenCalled();
        expect(encryptItemPayloadToBase64).toHaveBeenCalled();
    });

    it("localRev CAS mid-encrypt — concurrent write during crypto await → conflict, no clobber", async () => {
        await seed({ id: "note-race", type: "note", localRev: 1 });
        decryptItemPayload.mockResolvedValue({
            title: "N",
            contentTitle: "N",
            content: "<p>BASE</p>",
            starred: false,
        });
        createLocalConflictCopyFromPayload.mockResolvedValue({
            item: {
                id: "copy-race",
                type: "note",
                parent_id: null,
                encrypted_payload: "c",
                payload_nonce: "n",
                encrypted_item_key: "ik",
                item_key_nonce: "ikn",
                version: 1,
                dirty: true,
                sort_order: "copy-race",
                conflict_of: "note-race",
            } satisfies LocalItem,
            title: "N [Conflict]",
        });

        // During the encrypt await, another tab bumps localRev (simulating an overlapping save).
        encryptItemPayloadToBase64.mockImplementationOnce(async () => {
            const db = await getDB();
            const row = await db.get("items", "note-race");
            if (row) {
                row.localRev = 9;
                row.encrypted_payload = "from-other-tab";
                row.dirty = true;
                await db.put("items", row);
            }
            return { encrypted_payload: "stale-enc", payload_nonce: "stale-n" };
        });

        await expect(
            ItemService.updateItemPayload("note-race", "N", "<p>FROM THIS TAB</p>", {
                basedOnContent: "<p>BASE</p>",
            }),
        ).rejects.toBeInstanceOf(ConcurrentEditConflictError);

        expect(createLocalConflictCopyFromPayload).toHaveBeenCalled();
        const stored = await (await getDB()).get("items", "note-race");
        // The original has to stay the other tab's write, not a stale encrypt from this one.
        expect(stored?.encrypted_payload).toBe("from-other-tab");
        expect(stored?.localRev).toBe(9);
    });
});

describe("ItemService server-write CAS (a pull overwrite during the decrypt await)", () => {
    // Regression: a server write (a pull overwrite, a 409 resolution) reset localRev to undefined,
    // which `?? 0` could not tell apart from a row the server had written BEFORE this save began.
    // The payload derived from the stale decrypt then landed over the fresh server version under
    // its new `version`, the push matched, and the other device's edit was silently overwritten.
    it("pull overwrite (new version, localRev reset) mid-decrypt → conflict copy, server content kept", async () => {
        // The row was last written by the server: no localRev at all.
        await seed({ id: "note-pull", type: "note", version: 2, localRev: undefined });
        decryptItemPayload.mockImplementationOnce(async () => {
            // The pull lands while this save awaits the worker: a newer server version, and (as the
            // wire row carries none) localRev is again undefined.
            const db = await getDB();
            const row = await db.get("items", "note-pull");
            if (row) {
                row.version = 3;
                row.encrypted_payload = "server-v3";
                row.payload_nonce = "server-nonce";
                row.localRev = undefined;
                row.dirty = false;
                await db.put("items", row);
            }
            return { title: "N", contentTitle: "N", content: "<p>BASE</p>", starred: false };
        });
        createLocalConflictCopyFromPayload.mockResolvedValue({
            item: {
                id: "copy-pull",
                type: "note",
                parent_id: null,
                encrypted_payload: "c",
                payload_nonce: "n",
                encrypted_item_key: "ik",
                item_key_nonce: "ikn",
                version: 1,
                dirty: true,
                sort_order: "copy-pull",
                conflict_of: "note-pull",
            } satisfies LocalItem,
            title: "N [Conflict]",
        });

        await expect(
            ItemService.updateItemPayload("note-pull", "N", "<p>MINE</p>", {
                basedOnContent: "<p>BASE</p>",
            }),
        ).rejects.toBeInstanceOf(ConcurrentEditConflictError);

        expect(createLocalConflictCopyFromPayload).toHaveBeenCalled();
        expect(encryptItemPayloadToBase64).not.toHaveBeenCalled();
        const stored = await (await getDB()).get("items", "note-pull");
        expect(stored?.encrypted_payload).toBe("server-v3");
        expect(stored?.version).toBe(3);
        expect(stored?.dirty).toBe(false);
    });

    it("a version bump between the re-read and the write transaction is caught by the final CAS", async () => {
        await seed({ id: "note-late", type: "note", version: 2, localRev: undefined });
        decryptItemPayload.mockResolvedValue({
            title: "N",
            contentTitle: "N",
            content: "<p>BASE</p>",
            starred: false,
        });
        createLocalConflictCopyFromPayload.mockResolvedValue({
            item: {
                id: "copy-late",
                type: "note",
                parent_id: null,
                encrypted_payload: "c",
                payload_nonce: "n",
                encrypted_item_key: "ik",
                item_key_nonce: "ikn",
                version: 1,
                dirty: true,
                sort_order: "copy-late",
                conflict_of: "note-late",
            } satisfies LocalItem,
            title: "N [Conflict]",
        });
        // The pull lands during the encrypt await — after the re-read, before the write transaction.
        encryptItemPayloadToBase64.mockImplementationOnce(async () => {
            const db = await getDB();
            const row = await db.get("items", "note-late");
            if (row) {
                row.version = 3;
                row.encrypted_payload = "server-v3";
                row.localRev = undefined;
                await db.put("items", row);
            }
            return { encrypted_payload: "stale-enc", payload_nonce: "stale-n" };
        });

        await expect(
            ItemService.updateItemPayload("note-late", "N", "<p>MINE</p>", {
                basedOnContent: "<p>BASE</p>",
            }),
        ).rejects.toBeInstanceOf(ConcurrentEditConflictError);

        const stored = await (await getDB()).get("items", "note-late");
        expect(stored?.encrypted_payload).toBe("server-v3");
        expect(stored?.version).toBe(3);
    });
});

describe("ItemService — the ack of this tab's own push is not a conflict", () => {
    // The previous save is still being pushed: dirty, localRev 1, ciphertext "old-enc". Its ack lands
    // while the next save awaits the decrypt — applySucceeded moves only version/updated_at and dirty.
    async function ownAckDuringDecrypt(id: string) {
        await seed({ id, type: "note", version: 2, localRev: 1, dirty: true });
        decryptItemPayload.mockImplementationOnce(async () => {
            const db = await getDB();
            const row = await db.get("items", id);
            if (row) {
                row.version = 3;
                row.updated_at = 1_700_000_000;
                row.dirty = false;
                await db.put("items", row);
            }
            return { title: "N", contentTitle: "N", content: "<p>BASE</p>", starred: false };
        });
    }

    it("a star toggle right after a save writes, under the acked version, with no copy", async () => {
        await ownAckDuringDecrypt("note-star");
        await ItemService.updateItemStarred("note-star", true);

        expect(createLocalConflictCopyFromPayload).not.toHaveBeenCalled();
        expect(toastAdd).not.toHaveBeenCalled();
        const stored = await (await getDB()).get("items", "note-star");
        expect(stored?.encrypted_payload).toBe("new-enc");
        expect(stored?.version).toBe(3);
        expect(stored?.dirty).toBe(true);
        expect(pushItemMock).toHaveBeenCalledTimes(1);
    });

    it("an autosave whose baseline is the stored content writes, with no copy", async () => {
        await ownAckDuringDecrypt("note-save");
        await ItemService.updateItemPayload("note-save", "N", "<p>BASE + more</p>", {
            basedOnContent: "<p>BASE</p>",
        });

        expect(createLocalConflictCopyFromPayload).not.toHaveBeenCalled();
        const stored = await (await getDB()).get("items", "note-save");
        expect(stored?.encrypted_payload).toBe("new-enc");
        expect(stored?.version).toBe(3);
    });
});

describe("ItemService — a save that meets a push-409 copy writes into it", () => {
    // applyConflict has put the server row in place (ciphertext "server-enc", content SERVER) and made
    // copy-409 from this editor. The editor's baseline is still its own last save, BASE.
    async function afterPush409(id: string) {
        await seed({ id, type: "note", encrypted_payload: "server-enc", localRev: 4 });
        decryptItemPayload.mockResolvedValue({
            title: "N",
            contentTitle: "N",
            content: "<p>SERVER</p>",
            starred: false,
        });
    }

    it("writes our content into the named copy — no new copy, no toast", async () => {
        await afterPush409("note-409");
        replaceConflictCopyContent.mockResolvedValue("written");

        await expect(
            ItemService.updateItemPayload("note-409", "N", "<p>BASE + typed</p>", {
                basedOnContent: "<p>BASE</p>",
                intoConflictCopy: () => "copy-409",
            }),
        ).rejects.toBeInstanceOf(ConcurrentEditConflictError);

        expect(replaceConflictCopyContent).toHaveBeenCalledWith(
            "copy-409",
            "note-409",
            "N",
            "<p>BASE + typed</p>",
        );
        expect(createLocalConflictCopyFromPayload).not.toHaveBeenCalled();
        expect(conflictStoreAdd).not.toHaveBeenCalled();
        expect(toastAdd).not.toHaveBeenCalled();
        const stored = await (await getDB()).get("items", "note-409");
        expect(stored?.encrypted_payload).toBe("server-enc");
    });

    it("falls back to a new copy when that copy is gone — the text is kept", async () => {
        await afterPush409("note-gone");
        replaceConflictCopyContent.mockResolvedValue("unavailable");
        createLocalConflictCopyFromPayload.mockResolvedValue({
            item: {
                id: "copy-new",
                type: "note",
                parent_id: null,
                encrypted_payload: "c",
                payload_nonce: "n",
                encrypted_item_key: "ik",
                item_key_nonce: "ikn",
                version: 1,
                dirty: true,
                sort_order: "copy-new",
                conflict_of: "note-gone",
            } satisfies LocalItem,
            title: "N [Conflict]",
        });

        await expect(
            ItemService.updateItemPayload("note-gone", "N", "<p>BASE + typed</p>", {
                basedOnContent: "<p>BASE</p>",
                intoConflictCopy: () => "copy-409",
            }),
        ).rejects.toBeInstanceOf(ConcurrentEditConflictError);

        expect(createLocalConflictCopyFromPayload).toHaveBeenCalledTimes(1);
        expect(createLocalConflictCopyFromPayload.mock.calls[0]?.[1]).toMatchObject({
            content: "<p>BASE + typed</p>",
        });
        expect(await (await getDB()).get("items", "copy-new")).toBeDefined();
        expect(toastAdd).toHaveBeenCalledTimes(1);
    });

    it("saveTextAsConflictCopy keeps the text as a new copy and leaves the original alone", async () => {
        await afterPush409("note-text");
        createLocalConflictCopyFromPayload.mockResolvedValue({
            item: {
                id: "copy-text",
                type: "note",
                parent_id: null,
                encrypted_payload: "c",
                payload_nonce: "n",
                encrypted_item_key: "ik",
                item_key_nonce: "ikn",
                version: 1,
                dirty: true,
                sort_order: "copy-text",
                conflict_of: "note-text",
            } satisfies LocalItem,
            title: "N [Conflict]",
        });

        await ItemService.saveTextAsConflictCopy("note-text", "T", "<p>typed</p>");

        expect(createLocalConflictCopyFromPayload.mock.calls[0]?.[1]).toMatchObject({
            contentTitle: "T",
            content: "<p>typed</p>",
        });
        const db = await getDB();
        expect(await db.get("items", "copy-text")).toBeDefined();
        expect((await db.get("items", "note-text"))?.encrypted_payload).toBe("server-enc");
    });
});

describe("ItemService.permanentDeleteItem tombstone", () => {
    it("clears dirty and sync_error on the tombstone (a purged row has nothing to push or copy)", async () => {
        await seed({
            id: "note-tomb",
            type: "note",
            dirty: true,
            deleted_at: 1700000000,
            sync_error: "some error",
        });

        await ItemService.permanentDeleteItem("note-tomb");

        const row = await (await getDB()).get("items", "note-tomb");
        expect(row?.purged_at).toBeGreaterThan(0);
        expect(row?.dirty).toBe(false);
        expect(row?.sync_error).toBeUndefined();
    });
});

describe("ItemService.updateParent cycle detection", () => {
    it("refuses to move a folder into its own descendant", async () => {
        await seed({ id: "folder-root", type: "folder" });
        await seed({ id: "folder-child", type: "folder", parent_id: "folder-root" });

        await expect(ItemService.updateParent("folder-root", "folder-child")).rejects.toThrow(
            /Cannot move a folder into its own descendant/,
        );

        const root = await (await getDB()).get("items", "folder-root");
        expect(root?.parent_id).toBeNull();
    });

    it("allows moving a folder into another sibling / null", async () => {
        await seed({ id: "folder-a", type: "folder" });
        await seed({ id: "folder-b", type: "folder" });

        await ItemService.updateParent("folder-a", "folder-b");
        const a = await (await getDB()).get("items", "folder-a");
        expect(a?.parent_id).toBe("folder-b");
        expect(a?.dirty).toBe(true);
    });
});
