import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

function mockDecryptOne(item: { encrypted_payload?: string | null }) {
    return {
        title: item.encrypted_payload === "note" ? "My Note" : "photo.png",
        name: item.encrypted_payload === "file" ? "photo.png" : undefined,
        mime: "image/png",
        size: 1024,
    };
}

vi.mock("$lib/core/crypto/item-codec", () => ({
    decryptItemPayload: vi.fn(async (item: { encrypted_payload?: string | null }) =>
        mockDecryptOne(item),
    ),
    decryptManyItemPayloads: vi.fn(
        async (
            items: Array<{ id: string; encrypted_payload?: string | null }>,
        ): Promise<Array<{ id: string; data?: unknown; error?: Error }>> =>
            items.map((item) => ({ id: item.id, data: mockDecryptOne(item) })),
    ),
}));

vi.mock("$lib/core/utils/persisted", () => ({
    loadPersisted: vi.fn(() => "false"),
    rawStringSerde: {},
    STORAGE_KEYS: { pendingClearForUser: "pendingClearForUser" },
}));

import { decryptManyItemPayloads } from "$lib/core/crypto/item-codec";
import { getDB, type LocalItem } from "$lib/core/db";
import {
    batchAttachmentsForNote,
    countBatchAttachments,
    countVisibleTrashItems,
    getDeletedItems,
    getTreeItems,
    isIndividualTrashFile,
    isVisibleTrashRow,
    resetItemMetaCache,
} from "./items";

async function seed(over: Partial<LocalItem> & { id: string; type: LocalItem["type"] }) {
    const db = await getDB();
    await db.put("items", {
        parent_id: null,
        encrypted_payload: over.type === "file" ? "file" : "note",
        payload_nonce: "x",
        encrypted_item_key: "x",
        item_key_nonce: "x",
        version: 1,
        sort_order: over.id,
        dirty: false,
        localRev: 0,
        ...over,
    } as LocalItem);
}

beforeEach(async () => {
    vi.clearAllMocks();
    resetItemMetaCache();
    const db = await getDB();
    const tx = db.transaction("items", "readwrite");
    await tx.store.clear();
    await tx.done;
});

// A regression: getTreeItems used to re-decrypt EVERY item on every
// invalidation (33 places in the code, every successful push included) — O(N) × the number of
// invalidations.
describe("getTreeItems caching", () => {
    it("only re-decrypts items whose version/localRev changed since the last call, in one batch", async () => {
        await seed({ id: "note-1", type: "note", version: 1, localRev: 0 });
        await seed({ id: "note-2", type: "note", version: 1, localRev: 0 });
        await seed({ id: "note-3", type: "note", version: 1, localRev: 0 });

        await getTreeItems();
        expect(decryptManyItemPayloads).toHaveBeenCalledTimes(1);
        expect(vi.mocked(decryptManyItemPayloads).mock.calls[0]?.[0]).toHaveLength(3);

        vi.mocked(decryptManyItemPayloads).mockClear();

        // Change note-2 ONLY (as a local edit, or a pull that updates it, would).
        const db = await getDB();
        const item = await db.get("items", "note-2");
        await db.put("items", { ...item, version: 2, localRev: 1 } as LocalItem);

        const tree = await getTreeItems();
        expect(decryptManyItemPayloads).toHaveBeenCalledTimes(1);
        const batch = vi.mocked(decryptManyItemPayloads).mock.calls[0]?.[0];
        expect(batch).toHaveLength(1);
        expect(batch?.[0]?.id).toBe("note-2");
        // The unchanged items still carry the right (cached) metadata.
        expect(tree.find((i) => i.id === "note-1")?.title).toBe("My Note");
        expect(tree.find((i) => i.id === "note-2")?.title).toBe("My Note");
    });

    it("does not call the worker at all when nothing changed", async () => {
        await seed({ id: "note-1", type: "note", version: 1, localRev: 0 });
        await getTreeItems();
        vi.mocked(decryptManyItemPayloads).mockClear();

        await getTreeItems();
        expect(decryptManyItemPayloads).not.toHaveBeenCalled();
    });
});

describe("getDeletedItems", () => {
    it("returns trashed_batch_id for trashed entries", async () => {
        const batchId = "00000000-0000-7000-8000-000000000001";
        await seed({
            id: "note-1",
            type: "note",
            deleted_at: 1700000000,
            trashed_batch_id: batchId,
        });
        await seed({
            id: "file-1",
            type: "file",
            parent_id: "note-1",
            deleted_at: 1700000000,
            trashed_batch_id: batchId,
        });
        await seed({
            id: "file-manual",
            type: "file",
            parent_id: "note-1",
            deleted_at: 1700000001,
            trashed_batch_id: undefined,
        });

        const deleted = await getDeletedItems();

        expect(deleted.find((i) => i.id === "note-1")?.trashed_batch_id).toBe(batchId);
        expect(deleted.find((i) => i.id === "file-1")?.trashed_batch_id).toBe(batchId);
        expect(deleted.find((i) => i.id === "file-manual")?.trashed_batch_id).toBeNull();
    });
});

describe("countBatchAttachments", () => {
    it("counts only the files of the same batch under the given note", () => {
        const batchId = "00000000-0000-7000-8000-000000000002";
        const meta = [
            {
                id: "f1",
                type: "file" as const,
                parent_id: "note-1",
                trashed_batch_id: batchId,
                deleted_at: 1,
                sort_order: "a",
                title: "a",
                updated_at: 1,
                version: 1,
            },
            {
                id: "f2",
                type: "file" as const,
                parent_id: "note-1",
                trashed_batch_id: batchId,
                deleted_at: 1,
                sort_order: "b",
                title: "b",
                updated_at: 1,
                version: 1,
            },
            {
                id: "f3",
                type: "file" as const,
                parent_id: "note-1",
                trashed_batch_id: null,
                deleted_at: 1,
                sort_order: "c",
                title: "c",
                updated_at: 1,
                version: 1,
            },
            {
                id: "f4",
                type: "file" as const,
                parent_id: "note-2",
                trashed_batch_id: batchId,
                deleted_at: 1,
                sort_order: "d",
                title: "d",
                updated_at: 1,
                version: 1,
            },
        ];

        expect(countBatchAttachments(meta, "note-1", batchId)).toBe(2);
        expect(batchAttachmentsForNote(meta, "note-1", batchId)).toHaveLength(2);
        expect(isIndividualTrashFile(meta[2]!)).toBe(true);
        expect(isIndividualTrashFile(meta[0]!)).toBe(false);
    });

    it("countVisibleTrashItems: notes/folders + individual files; batch attachments are not counted", () => {
        const batchId = "batch-1";
        const meta = [
            {
                id: "n1",
                type: "note" as const,
                parent_id: null,
                deleted_at: 1,
                sort_order: "a",
                title: "Note",
                updated_at: 1,
                version: 1,
            },
            {
                id: "f-batch",
                type: "file" as const,
                parent_id: "n1",
                trashed_batch_id: batchId,
                deleted_at: 1,
                sort_order: "b",
                title: "batch file",
                updated_at: 1,
                version: 1,
            },
            {
                id: "f-solo",
                type: "file" as const,
                parent_id: "n1",
                trashed_batch_id: null,
                deleted_at: 1,
                sort_order: "c",
                title: "solo file",
                updated_at: 1,
                version: 1,
            },
            {
                id: "f2",
                type: "folder" as const,
                parent_id: null,
                deleted_at: 1,
                sort_order: "d",
                title: "Folder",
                updated_at: 1,
                version: 1,
            },
        ];
        // a note + a solo file + a folder = 3; the batch file is in the accordion, not in the badge
        expect(countVisibleTrashItems(meta)).toBe(3);
        expect(isVisibleTrashRow(meta[0]!)).toBe(true);
        expect(isVisibleTrashRow(meta[1]!)).toBe(false);
        expect(isVisibleTrashRow(meta[2]!)).toBe(true);
        expect(isVisibleTrashRow(meta[3]!)).toBe(true);
    });
});
