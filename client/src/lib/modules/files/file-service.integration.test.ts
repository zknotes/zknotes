import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// We mock the side-effect infrastructure — we are testing the lifecycle logic (the IDB state, the guard and the emit), not the network or crypto.
vi.mock("$lib/core/api", () => ({
    pushBatch: vi.fn().mockResolvedValue({ succeeded: [], conflicts: [], errors: [] }),
}));
vi.mock("$lib/core/sync", () => {
    const pushItem = vi.fn().mockResolvedValue(undefined);
    return {
        enqueueMutation: vi.fn().mockResolvedValue(undefined),
        applyRefusedDeletes: vi.fn().mockResolvedValue(undefined),
        pushItem,
        // The service pushes through pushOrQueue; assertions on pushItem keep counting.
        pushOrQueue: vi.fn((item: unknown) => {
            void pushItem(item);
        }),
    };
});
vi.mock("$lib/core/search", () => ({ removeDoc: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./invalidation", () => ({ invalidateFile: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./cleanup", () => ({
    removeFileRefsEverywhere: vi.fn().mockResolvedValue(["srcNote"]),
    noteContainsFileEmbed: vi.fn().mockResolvedValue(true),
    cleanupOrphanedFileRefs: vi.fn().mockResolvedValue([]),
}));
vi.mock("$lib/modules/files/storage-manager", () => ({
    evictChunkSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/core/services/item-service", () => ({
    ItemService: {
        reencryptAndSave: vi.fn().mockResolvedValue(undefined),
        updateParent: vi.fn().mockResolvedValue(undefined),
        appendFileToNote: vi.fn().mockResolvedValue(undefined),
        getDecryptedItem: vi.fn().mockResolvedValue(null),
        // Mirrors the real primitive: a dirty bump + persist (the tests check the IDB state).
        markDirtyAndPush: vi.fn(async (item: LocalItem) => {
            item.dirty = true;
            item.localRev = (item.localRev || 0) + 1;
            item.updated_at = Math.floor(Date.now() / 1000);
            const { getDB } = await import("$lib/core/db");
            await (await getDB()).put("items", item);
        }),
    },
}));
vi.mock("./upload", () => ({ replaceFileContent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./blob-cache", () => ({ invalidate: vi.fn() }));
vi.mock("./files-changed-bus", () => ({ emitFilesChanged: vi.fn(), emitNotesChanged: vi.fn() }));
vi.mock("./file-invalidator", () => ({
    notifyFileInvalidated: vi.fn(),
    notifyFileMoved: vi.fn(),
    notifyFileTrashed: vi.fn(),
    notifyFileRestored: vi.fn(),
}));

import { getDB, type LocalItem } from "$lib/core/db";
import { ItemService } from "$lib/core/services/item-service";
import { removeFileRefsEverywhere } from "./cleanup";
import { FileService } from "./file-service";
import { emitFilesChanged, emitNotesChanged } from "./files-changed-bus";

let seq = 0;
function makeId(): string {
    seq += 1;
    return `0192f000-0000-7000-8000-${String(seq).padStart(12, "0")}`;
}

async function seed(over: Partial<LocalItem> & { id: string; type: LocalItem["type"] }) {
    const db = await getDB();
    const item: LocalItem = {
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
    } as LocalItem;
    await db.put("items", item);
    return item;
}

async function get(id: string) {
    return (await getDB()).get("items", id);
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("FileService.move", () => {
    it("append → reparent → strip (crash-safe) + emit (files + notes)", async () => {
        const fileId = makeId();
        const toNote = makeId();
        // Move now has a READY guard, so the row has to exist and be READY.
        await seed({ id: fileId, type: "file" });
        await FileService.move(fileId, toNote, "doc.pdf", "application/pdf");

        expect(ItemService.appendFileToNote).toHaveBeenCalledWith(
            toNote,
            fileId,
            "doc.pdf",
            "application/pdf",
            // The dimensions are passed through; for a non-image they are undefined.
            { width: undefined, height: undefined },
        );
        expect(ItemService.updateParent).toHaveBeenCalledWith(fileId, toNote);
        expect(removeFileRefsEverywhere).toHaveBeenCalledWith([fileId], {
            excludeNoteIds: [toNote],
        });
        // The order: append before reparent, reparent before strip
        const appendOrder = vi.mocked(ItemService.appendFileToNote).mock.invocationCallOrder[0];
        const parentOrder = vi.mocked(ItemService.updateParent).mock.invocationCallOrder[0];
        const stripOrder = vi.mocked(removeFileRefsEverywhere).mock.invocationCallOrder[0];
        expect(appendOrder).toBeLessThan(parentOrder!);
        expect(parentOrder).toBeLessThan(stripOrder!);

        expect(emitFilesChanged).toHaveBeenCalledWith([fileId]);
        // The notes bus: the affected notes = the stripped ones (the mock returns ["srcNote"]) plus the destination, deduplicated.
        expect(emitNotesChanged).toHaveBeenCalledTimes(1);
        const notes = vi.mocked(emitNotesChanged).mock.calls[0]?.[0] ?? [];
        expect([...notes].sort()).toEqual(["srcNote", toNote].sort());
    });
});

describe("FileService.createFromUpload", () => {
    it("writes the item into IDB and emits (the axis 1 → axis 2 handoff)", async () => {
        const id = makeId();
        const item = {
            id,
            parent_id: null,
            type: "file",
            encrypted_payload: "x",
            payload_nonce: "x",
            encrypted_item_key: "x",
            item_key_nonce: "x",
            chunk_set_id: makeId(),
            chunk_count: 1,
            ciphertext_size: 10,
            version: 1,
            sort_order: id,
            dirty: true,
            localRev: 0,
        } as LocalItem;
        await FileService.createFromUpload(item);
        expect((await get(id))?.id).toBe(id);
        expect(emitFilesChanged).toHaveBeenCalledWith([id]);
    });
});

describe("FileService.trash", () => {
    it("READY file → TRASHED (deleted_at set, dirty=true synced) + emit + strip embeds", async () => {
        const id = makeId();
        await seed({ id, type: "file" });
        await FileService.trash(id);
        const row = await get(id);
        expect(row?.deleted_at).toBeGreaterThan(0);
        expect(row?.dirty).toBe(true);
        expect(removeFileRefsEverywhere).toHaveBeenCalledWith([id]);
        expect(emitFilesChanged).toHaveBeenCalledWith([id]);
        expect(emitNotesChanged).toHaveBeenCalledWith(["srcNote"]);
    });

    it("idempotent: a second trash is a no-op (no further change and no emit)", async () => {
        const id = makeId();
        await seed({ id, type: "file" });
        await FileService.trash(id);
        const firstTs = (await get(id))?.deleted_at;
        vi.clearAllMocks();
        await FileService.trash(id);
        expect((await get(id))?.deleted_at).toBe(firstTs);
        expect(emitFilesChanged).not.toHaveBeenCalled();
    });

    it("ne-file (note) → no-op", async () => {
        const id = makeId();
        await seed({ id, type: "note" });
        await FileService.trash(id);
        expect((await get(id))?.deleted_at).toBeUndefined();
        expect(emitFilesChanged).not.toHaveBeenCalled();
    });

    it("gone (there is no row) → a no-op", async () => {
        await FileService.trash(makeId());
        expect(emitFilesChanged).not.toHaveBeenCalled();
    });
});

describe("FileService.restore", () => {
    it("TRASHED → READY (deleted_at cleared, dirty=true) plus an emit", async () => {
        const id = makeId();
        await seed({ id, type: "file", deleted_at: 123 });
        await FileService.restore(id);
        const row = await get(id);
        expect(row?.deleted_at).toBeUndefined();
        expect(row?.dirty).toBe(true);
        expect(emitFilesChanged).toHaveBeenCalledWith([id]);
    });

    it("already READY → a no-op", async () => {
        const id = makeId();
        await seed({ id, type: "file" });
        await FileService.restore(id);
        expect(emitFilesChanged).not.toHaveBeenCalled();
    });

    it("the owner note is gone → it restores to the root (parent_id=null)", async () => {
        const id = makeId();
        await seed({ id, type: "file", parent_id: "dead-note-id", deleted_at: 123 });
        await FileService.restore(id);
        expect((await get(id))?.parent_id).toBeNull();
    });

    it("the owning note is deleted → it restores to the root", async () => {
        const owner = makeId();
        const id = makeId();
        await seed({ id: owner, type: "note", deleted_at: 999 });
        await seed({ id, type: "file", parent_id: owner, deleted_at: 123 });
        await FileService.restore(id);
        expect((await get(id))?.parent_id).toBeNull();
    });

    it("the owner note is alive (READY) → keep parent_id", async () => {
        const owner = makeId();
        const id = makeId();
        await seed({ id: owner, type: "note" });
        await seed({ id, type: "file", parent_id: owner, deleted_at: 123 });
        await FileService.restore(id);
        expect((await get(id))?.parent_id).toBe(owner);
    });
});

describe("FileService.hardDelete", () => {
    it("deletes the row, emits, and cleans up orphans", async () => {
        const id = makeId();
        await seed({ id, type: "file", deleted_at: 123 });

        const { cleanupOrphanedFileRefs } = await import("./cleanup");
        vi.mocked(cleanupOrphanedFileRefs).mockClear();

        await FileService.hardDelete(id);
        expect(await get(id)).toBeUndefined();
        expect(emitFilesChanged).toHaveBeenCalledWith([id]);
        expect(cleanupOrphanedFileRefs).toHaveBeenCalledWith([id]);
    });

    it("several ids at once", async () => {
        const a = makeId();
        const b = makeId();
        await seed({ id: a, type: "file", deleted_at: 1 });
        await seed({ id: b, type: "file", deleted_at: 1 });
        await FileService.hardDelete([a, b]);
        expect(await get(a)).toBeUndefined();
        expect(await get(b)).toBeUndefined();
        expect(emitFilesChanged).toHaveBeenCalledWith([a, b]);
    });

    it("offline (pushBatch fails) → the tombstone stays (purged_at), the row is NOT deleted, the delete is enqueued", async () => {
        const { pushBatch } = await import("$lib/core/api");
        const { enqueueMutation } = await import("$lib/core/sync");
        vi.mocked(pushBatch).mockRejectedValueOnce(new Error("offline"));

        const id = makeId();
        await seed({ id, type: "file", deleted_at: 123 });
        await FileService.hardDelete(id);

        const row = await get(id);
        expect(row).toBeDefined(); // the row is NOT deleted before the server's ack (the pull guard does not resurrect it)
        expect(row?.purged_at).toBeGreaterThan(0); // tombstone
        expect(enqueueMutation).toHaveBeenCalledWith(id, "delete");
    });

    it("online (pushBatch succeeds) → the row is deleted after the ack", async () => {
        const id = makeId();
        await seed({ id, type: "file", deleted_at: 123 });
        await FileService.hardDelete(id);
        expect(await get(id)).toBeUndefined();
    });

    it("the embed strip runs only AFTER the server acknowledged the purge", async () => {
        const { pushBatch } = await import("$lib/core/api");
        const { cleanupOrphanedFileRefs } = await import("./cleanup");
        vi.mocked(cleanupOrphanedFileRefs).mockClear();
        vi.mocked(pushBatch).mockClear();

        const id = makeId();
        await seed({ id, type: "file", deleted_at: 123 });
        await FileService.hardDelete(id);

        expect(cleanupOrphanedFileRefs).toHaveBeenCalledWith([id]);
        const pushOrder =
            vi.mocked(pushBatch).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
        const stripOrder = vi.mocked(cleanupOrphanedFileRefs).mock.invocationCallOrder[0] ?? -1;
        expect(stripOrder).toBeGreaterThan(pushOrder);
    });

    it("offline → no strip before the ack (the drain strips once the server confirms)", async () => {
        const { pushBatch } = await import("$lib/core/api");
        const { cleanupOrphanedFileRefs } = await import("./cleanup");
        vi.mocked(cleanupOrphanedFileRefs).mockClear();
        vi.mocked(pushBatch).mockRejectedValueOnce(new Error("offline"));

        const id = makeId();
        await seed({ id, type: "file", deleted_at: 123 });
        await FileService.hardDelete(id);

        expect(cleanupOrphanedFileRefs).not.toHaveBeenCalled();
        expect((await get(id))?.purged_at).toBeGreaterThan(0);
    });

    it("refused purge (a version conflict) → the row is not deleted, no embed is stripped, the refusal is applied", async () => {
        const { pushBatch } = await import("$lib/core/api");
        const { applyRefusedDeletes } = await import("$lib/core/sync");
        const { cleanupOrphanedFileRefs } = await import("./cleanup");
        vi.mocked(cleanupOrphanedFileRefs).mockClear();

        const id = makeId();
        await seed({ id, type: "file", deleted_at: 123, version: 2 });
        // Restored on another device meanwhile (v3) — the server keeps the file alive.
        const conflicts = [{ id, current_item: { id, version: 3 } }];
        vi.mocked(pushBatch).mockResolvedValueOnce({
            succeeded: [],
            conflicts,
            errors: [],
        } as never);

        await FileService.hardDelete(id);

        expect(applyRefusedDeletes).toHaveBeenCalledWith(conflicts);
        // Not deleted locally (the real applyRefusedDeletes replaces the tombstone with the server row).
        expect(await get(id)).toBeDefined();
        expect(cleanupOrphanedFileRefs).not.toHaveBeenCalled();
        expect(emitFilesChanged).toHaveBeenCalledWith([id]);
    });

    it("gone → a no-op (with no emit)", async () => {
        await FileService.hardDelete(makeId());
        expect(emitFilesChanged).not.toHaveBeenCalled();
    });

    it("an empty array → a no-op", async () => {
        await FileService.hardDelete([]);
        expect(emitFilesChanged).not.toHaveBeenCalled();
    });
});

// ── The service asks FileLifecycle.can() before writing ───────────────────────────────────────

describe("FileService — the lifecycle guards", () => {
    it("a hardDelete on a READY file is a no-op (TRASHED → DELETED is the only way into DELETED)", async () => {
        const id = makeId();
        await seed({ id, type: "file" }); // READY: no deleted_at

        await FileService.hardDelete(id);

        const row = await get(id);
        expect(row).toBeDefined();
        expect(row?.purged_at).toBeUndefined();
        expect(emitFilesChanged).not.toHaveBeenCalled();
    });

    it("hardDelete over a mixed list: it purges only the TRASHED ones and skips READY", async () => {
        const trashed = makeId();
        const ready = makeId();
        await seed({ id: trashed, type: "file", deleted_at: 1 });
        await seed({ id: ready, type: "file" });

        await FileService.hardDelete([trashed, ready]);

        expect(await get(trashed)).toBeUndefined();
        expect(await get(ready)).toBeDefined();
        expect(emitFilesChanged).toHaveBeenCalledWith([trashed]);
    });

    it("a crop on a TRASHED file is a no-op (a READY-only mutation, no new blob)", async () => {
        const id = makeId();
        await seed({ id, type: "file", deleted_at: 123 });

        const { replaceFileContent } = await import("./upload");
        await FileService.crop(id, new File(["x"], "a.png", { type: "image/png" }));

        expect(replaceFileContent).not.toHaveBeenCalled();
        expect(emitFilesChanged).not.toHaveBeenCalled();
    });

    it("a crop on a READY file still goes through", async () => {
        const id = makeId();
        await seed({ id, type: "file" });

        const { replaceFileContent } = await import("./upload");
        await FileService.crop(id, new File(["x"], "a.png", { type: "image/png" }));

        expect(replaceFileContent).toHaveBeenCalled();
        expect(emitFilesChanged).toHaveBeenCalledWith([id]);
    });
});

// ── An embed inserted through restore/move/link has to carry the intrinsic dimensions IMMEDIATELY.
// Without them the node jumps on its FIRST render — the self-heal writes them only after
// `img.load`, which is after the decryption, so the first render is still CLS.

describe("FileService — the dimensions on an inserted embed (anti-CLS)", () => {
    it("restore passes width and height from the payload into appendFileToNote", async () => {
        const fileId = makeId();
        const noteId = makeId();
        await seed({ id: noteId, type: "note" });
        await seed({ id: fileId, type: "file", parent_id: noteId, deleted_at: 123 });

        const { noteContainsFileEmbed } = await import("./cleanup");
        vi.mocked(noteContainsFileEmbed).mockResolvedValueOnce(false);
        vi.mocked(ItemService.getDecryptedItem).mockResolvedValue({
            payload: { name: "picture.png", mime: "image/png", width: 1600, height: 900 },
        } as never);

        await FileService.restore(fileId);

        expect(ItemService.appendFileToNote).toHaveBeenCalledWith(
            noteId,
            fileId,
            "picture.png",
            "image/png",
            { width: 1600, height: 900 },
        );
    });

    it("move passes the dimensions; without them it sends undefined, and a non-image still works", async () => {
        const fileId = makeId();
        const toNote = makeId();
        vi.mocked(ItemService.getDecryptedItem).mockResolvedValue({
            payload: { name: "doc.pdf", mime: "application/pdf" },
        } as never);
        await seed({ id: fileId, type: "file" });

        await FileService.move(fileId, toNote, "doc.pdf", "application/pdf");

        expect(ItemService.appendFileToNote).toHaveBeenCalledWith(
            toNote,
            fileId,
            "doc.pdf",
            "application/pdf",
            { width: undefined, height: undefined },
        );
    });

    it("a move on a TRASHED file is a no-op (READY-only)", async () => {
        const fileId = makeId();
        await seed({ id: fileId, type: "file", deleted_at: 123 });

        await FileService.move(fileId, makeId(), "x.png", "image/png");

        expect(ItemService.appendFileToNote).not.toHaveBeenCalled();
        expect(ItemService.updateParent).not.toHaveBeenCalled();
    });

    it("a rename on a TRASHED file is a no-op", async () => {
        const fileId = makeId();
        await seed({ id: fileId, type: "file", deleted_at: 123 });

        await FileService.rename(fileId, { name: "novo.png" });

        expect(ItemService.reencryptAndSave).not.toHaveBeenCalled();
    });
});
