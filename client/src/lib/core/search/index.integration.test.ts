import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    buildIndexTask,
    loadPersistedIndexTask,
    serializeIndexTask,
    addIndexDocTask,
    searchIndexTask,
} = vi.hoisted(() => ({
    buildIndexTask: vi.fn().mockResolvedValue({ count: 1 }),
    loadPersistedIndexTask: vi.fn(),
    serializeIndexTask: vi.fn().mockResolvedValue({
        empty: false,
        ciphertext: new Uint8Array([1]),
        nonce: new Uint8Array([2]),
        ikCiphertext: new Uint8Array([3]),
        ikNonce: new Uint8Array([4]),
    }),
    addIndexDocTask: vi.fn().mockResolvedValue(undefined),
    searchIndexTask: vi.fn().mockResolvedValue([{ id: "note-1", title: "Hello" }]),
}));

vi.mock("$lib/core/crypto/item-codec", () => ({
    decryptItemPayload: vi.fn().mockResolvedValue({ title: "Hello", content: "world" }),
    decryptManyItemPayloads: vi
        .fn()
        .mockImplementation(async (items: Array<{ id: string }>) =>
            items.map((item) => ({ id: item.id, data: { title: "Hello", content: "world" } })),
        ),
}));

vi.mock("$lib/core/workers/crypto-rpc", () => ({
    buildIndexTask,
    loadPersistedIndexTask,
    serializeIndexTask,
    addIndexDocTask,
    removeIndexDocTask: vi.fn(),
    searchIndexTask,
}));

import { ItemService } from "$lib/core/services/item-service";
import { getDB, type LocalItem } from "$lib/core/db";
import {
    addOrUpdateDoc,
    cancelPendingPersist,
    flushIndex,
    loadOrBuildIndex,
    search,
} from "./index";

describe("search index", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        buildIndexTask.mockResolvedValue({ count: 1 });
        serializeIndexTask.mockResolvedValue({
            empty: false,
            ciphertext: new Uint8Array([1]),
            nonce: new Uint8Array([2]),
            ikCiphertext: new Uint8Array([3]),
            ikNonce: new Uint8Array([4]),
        });
        searchIndexTask.mockResolvedValue([{ id: "note-1", title: "Hello" }]);
        const db = await getDB();
        await db.clear("items");
        await db.clear("search-index");
    });

    it("loadOrBuildIndex rebuilds from items when no persisted index exists", async () => {
        const db = await getDB();
        await db.put("items", {
            id: "note-1",
            type: "note",
            parent_id: null,
            encrypted_payload: "x",
            payload_nonce: "x",
            encrypted_item_key: "x",
            item_key_nonce: "x",
            sort_order: "m",
            version: 1,
            dirty: false,
            localRev: 0,
        } as LocalItem);

        const result = await loadOrBuildIndex();

        expect(result).toEqual({ rebuilt: true, count: 1 });
        expect(buildIndexTask).toHaveBeenCalledOnce();
    });

    it("addOrUpdateDoc + search delegates to worker tasks", async () => {
        await addOrUpdateDoc({ id: "note-2", type: "note", title: "Added" });
        const hits = await search("added");

        expect(addIndexDocTask).toHaveBeenCalledWith({
            id: "note-2",
            type: "note",
            title: "Added",
        });
        expect(searchIndexTask).toHaveBeenCalledWith("added", 20);
        expect(hits).toEqual([{ id: "note-1", title: "Hello" }]);
    });

    it("flushIndex persists serialized blob to search-index store", async () => {
        await addOrUpdateDoc({ id: "note-1", type: "note", title: "T" });
        await flushIndex();

        const db = await getDB();
        const stored = await db.get("search-index", "index");
        expect(stored).toEqual({
            id: "index",
            ciphertext: new Uint8Array([1]),
            nonce: new Uint8Array([2]),
            ikCiphertext: new Uint8Array([3]),
            ikNonce: new Uint8Array([4]),
        });
    });

    it("cancelPendingPersist prevents a subsequent flush after teardown", async () => {
        await addOrUpdateDoc({ id: "note-1", type: "note", title: "T" });
        cancelPendingPersist();
        await flushIndex();

        const db = await getDB();
        expect(await db.get("search-index", "index")).toBeUndefined();
        expect(serializeIndexTask).not.toHaveBeenCalled();
    });

    it("restoreItem puts the note back into the search index", async () => {
        const db = await getDB();
        await db.put("items", {
            id: "note-1",
            type: "note",
            parent_id: null,
            encrypted_payload: "x",
            payload_nonce: "x",
            encrypted_item_key: "x",
            item_key_nonce: "x",
            sort_order: "m",
            version: 1,
            dirty: false,
            localRev: 0,
            deleted_at: 1000,
        } as LocalItem);

        await ItemService.restoreItem("note-1");

        expect(addIndexDocTask).toHaveBeenCalledWith({
            id: "note-1",
            type: "note",
            title: "Hello",
            content: "world",
        });
    });
});
