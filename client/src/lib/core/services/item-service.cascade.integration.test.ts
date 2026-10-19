import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the side-effect infrastructure — we are testing the cascade lifecycle (the IDB state), not the network, crypto or index.
vi.mock("$lib/core/api", () => ({ pushBatch: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/core/sync", () => {
    const pushItem = vi.fn().mockResolvedValue(undefined);
    return {
        pushDeletes: vi.fn().mockResolvedValue(undefined),
        enqueueMutation: vi.fn().mockResolvedValue(undefined),
        pushItem,
        // The service pushes through pushOrQueue; assertions on pushItem keep counting.
        pushOrQueue: vi.fn((item: unknown) => {
            void pushItem(item);
        }),
    };
});
vi.mock("$lib/core/search", () => ({
    addOrUpdateDoc: vi.fn().mockResolvedValue(undefined),
    removeDoc: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/core/events/file-bridge", () => ({
    fileBridge: { invalidateFile: vi.fn().mockResolvedValue(undefined) },
}));

import { getDB, type LocalItem } from "$lib/core/db";
import { ItemService } from "./item-service";

let seq = 0;
function id(p: string): string {
    seq += 1;
    return `${p}-${seq}`;
}

async function seed(over: Partial<LocalItem> & { id: string; type: LocalItem["type"] }) {
    const db = await getDB();
    await db.put("items", {
        parent_id: null,
        encrypted_payload: "x",
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

const get = async (i: string) => (await getDB()).get("items", i);
const isTrashed = async (i: string) => (await get(i))?.deleted_at != null;

beforeEach(() => vi.clearAllMocks());

describe("deleteItem — the cascade trash (itself + its descendants)", () => {
    it("deleting a folder trashes every descendant (notes + a file)", async () => {
        const f = id("F");
        const n1 = id("N");
        const file = id("FILE");
        await seed({ id: f, type: "folder" });
        await seed({ id: n1, type: "note", parent_id: f });
        await seed({ id: file, type: "file", parent_id: n1 });

        await ItemService.deleteItem(f);

        expect(await isTrashed(f)).toBe(true);
        expect(await isTrashed(n1)).toBe(true);
        expect(await isTrashed(file)).toBe(true);
    });
});

describe("deleteItem — note → file cascade (E2E 13 parity)", () => {
    it("deleting a note trashes its file child; restoring the note brings the file back", async () => {
        const n = id("N");
        const file = id("FILE");
        await seed({ id: n, type: "note" });
        await seed({ id: file, type: "file", parent_id: n });

        await ItemService.deleteItem(n);
        expect(await isTrashed(n)).toBe(true);
        expect(await isTrashed(file)).toBe(true);

        await ItemService.restoreItem(n);
        expect(await isTrashed(n)).toBe(false);
        expect(await isTrashed(file)).toBe(false);
    });
});

describe("restoreItem — down cascade", () => {
    it("restoring a folder brings back every trashed descendant", async () => {
        const f = id("F");
        const n1 = id("N");
        const n2 = id("N");
        const file = id("FILE");
        await seed({ id: f, type: "folder" });
        await seed({ id: n1, type: "note", parent_id: f });
        await seed({ id: n2, type: "note", parent_id: f });
        await seed({ id: file, type: "file", parent_id: n1 });

        await ItemService.deleteItem(f);
        await ItemService.restoreItem(f);

        expect(await isTrashed(f)).toBe(false);
        expect(await isTrashed(n1)).toBe(false);
        expect(await isTrashed(n2)).toBe(false);
        expect(await isTrashed(file)).toBe(false);
    });
});

describe("restoreItem — the up cascade (restoring a child brings its parents back)", () => {
    it("restoring a note brings back its folder (upwards) and its file (downwards), but NOT a sibling note", async () => {
        const f = id("F");
        const n1 = id("N");
        const n2 = id("N"); // sibling
        const file = id("FILE");
        await seed({ id: f, type: "folder" });
        await seed({ id: n1, type: "note", parent_id: f });
        await seed({ id: n2, type: "note", parent_id: f });
        await seed({ id: file, type: "file", parent_id: n1 });

        await ItemService.deleteItem(f); // everything into Trash
        await ItemService.restoreItem(n1); // restore note n1 only

        expect(await isTrashed(n1)).toBe(false); // self
        expect(await isTrashed(f)).toBe(false); // the ancestor (up)
        expect(await isTrashed(file)).toBe(false); // the descendant (down)
        expect(await isTrashed(n2)).toBe(true); // the sibling STAYS in Trash
    });

    it("the owner-gone guard: restoring a file whose owner is missing → parent_id=null (the root)", async () => {
        const file = id("FILE");
        await seed({ id: file, type: "file", parent_id: "dead-owner", deleted_at: 123 });

        await ItemService.restoreItem(file);

        const row = await get(file);
        expect(row?.deleted_at).toBeUndefined();
        expect(row?.parent_id).toBeNull();
    });
});

describe("permanentDeleteItem — cascade purge", () => {
    it("purging a folder deletes its trashed descendants too, so no file is left orphaned", async () => {
        const f = id("F");
        const n1 = id("N");
        const file = id("FILE");
        await seed({ id: f, type: "folder" });
        await seed({ id: n1, type: "note", parent_id: f });
        await seed({ id: file, type: "file", parent_id: n1 });

        await ItemService.deleteItem(f); // into Trash
        await ItemService.permanentDeleteItem(f); // purge the folder

        expect((await get(f))?.purged_at).toBeDefined();
        expect((await get(n1))?.purged_at).toBeDefined();
        expect((await get(file))?.purged_at).toBeDefined(); // no orphans
    });

    it("it does not purge LIVE (READY) descendants — only trashed ones", async () => {
        const f = id("F");
        const live = id("N");
        await seed({ id: f, type: "folder", deleted_at: 1 }); // the folder is trashed
        await seed({ id: live, type: "note", parent_id: f }); // a READY child (the edge case)

        await ItemService.permanentDeleteItem(f);

        expect((await get(f))?.purged_at).toBeDefined();
        expect(await get(live)).toBeDefined(); // the READY child survives
    });
});

describe("trashed_batch_id", () => {
    it("restoring a note brings back only the descendants deleted in the same operation", async () => {
        const n1 = id("N");
        const f1 = id("FILE");
        const f2 = id("FILE");
        const f_manual = id("FILE");

        await seed({ id: n1, type: "note" });
        await seed({ id: f1, type: "file", parent_id: n1 });
        await seed({ id: f2, type: "file", parent_id: n1 });
        await seed({ id: f_manual, type: "file", parent_id: n1 });

        // 1 file was trashed by hand earlier
        await ItemService.deleteItem(f_manual);

        // the note + 2 files trashed together
        await ItemService.deleteItem(n1);

        // restore the note
        await ItemService.restoreItem(n1);

        expect(await isTrashed(n1)).toBe(false);
        expect(await isTrashed(f1)).toBe(false);
        expect(await isTrashed(f2)).toBe(false);
        // the file deleted by hand earlier stays in Trash, because it has a different trashed_batch_id
        expect(await isTrashed(f_manual)).toBe(true);
    });
});

// ── The trash transition is approved by FileLifecycle, not by `!deleted_at` ──

describe("deleteItem — the lifecycle guard", () => {
    it("it skips a locally purged (DELETED) row — DELETED has no outgoing transition", async () => {
        const folder = id("folder");
        const tombstoned = id("note");
        await seed({ id: folder, type: "folder" });
        // permanentDeleteItem / FileService.hardDelete tombstone ONLY purged_at; deleted_at
        // stays empty until the server confirms. The old `!item.deleted_at` condition would have
        // trashed it again and sent an upsert for an item that is already permanently deleted.
        await seed({ id: tombstoned, type: "note", parent_id: folder, purged_at: 1000 });

        await ItemService.deleteItem(folder);

        expect(await isTrashed(folder)).toBe(true);
        const row = await get(tombstoned);
        expect(row?.deleted_at).toBeUndefined();
        expect(row?.trashed_batch_id).toBeUndefined();
        expect(row?.dirty).toBe(false);
    });

    it("it still trashes ordinary READY descendants (the guard must not stop the cascade)", async () => {
        const folder = id("folder");
        const note = id("note");
        await seed({ id: folder, type: "folder" });
        await seed({ id: note, type: "note", parent_id: folder });

        await ItemService.deleteItem(folder);

        expect(await isTrashed(note)).toBe(true);
        expect((await get(note))?.dirty).toBe(true);
    });
});
