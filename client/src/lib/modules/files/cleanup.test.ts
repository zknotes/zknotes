// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    getDecryptedItemMock,
    updateItemPayloadMock,
    reencryptAndSaveMock,
    appendFileToNoteMock,
    fileServiceMoveMock,
    decryptManyItemPayloadsMock,
} = vi.hoisted(() => ({
    getDecryptedItemMock: vi.fn(),
    updateItemPayloadMock: vi.fn().mockResolvedValue(undefined),
    reencryptAndSaveMock: vi.fn(),
    appendFileToNoteMock: vi.fn().mockResolvedValue(undefined),
    fileServiceMoveMock: vi.fn().mockResolvedValue(undefined),
    // removeFileRefsFromNotes batch-decrypts via this instead of ItemService.getDecryptedItem per
    // note (query "perf 9") — swapFileRefInNoteContent/noteContainsFileEmbed still use the latter.
    decryptManyItemPayloadsMock: vi.fn(),
}));

vi.mock("$lib/core/services/item-service", () => ({
    ItemService: {
        getDecryptedItem: getDecryptedItemMock,
        updateItemPayload: updateItemPayloadMock,
        reencryptAndSave: reencryptAndSaveMock,
        appendFileToNote: appendFileToNoteMock,
    },
}));
vi.mock("$lib/core/crypto/item-codec", () => ({
    decryptManyItemPayloads: decryptManyItemPayloadsMock,
}));
vi.mock("./file-service", () => ({
    FileService: { move: fileServiceMoveMock },
}));
vi.mock("./files-changed-bus", () => ({ emitNotesChanged: vi.fn() }));

import { APP_EVENTS } from "$lib/core/constants/events";
import { getDB, type LocalItem } from "$lib/core/db";
import {
    cleanupOrphanedFileRefs,
    moveFileEmbedBetweenNotes,
    removeFileRefsEverywhere,
    removeFileRefsFromNotes,
    swapFileRefInNoteContent,
} from "./cleanup";
import { emitNotesChanged } from "./files-changed-bus";

function notePayload(content: string, title = "Note") {
    return {
        type: "note" as const,
        payload: { title, contentTitle: title, content },
    };
}

describe("swapFileRefInNoteContent", () => {
    // What the note stores. The mock hands it to mutate the way reencryptAndSave does — read inside
    // the item write lock — and keeps what mutate returns (null: nothing written).
    let stored: Record<string, unknown>;

    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("items");
        await db.put("items", { id: "note-1", type: "note" } as LocalItem);
        reencryptAndSaveMock.mockImplementation(
            async (id: string, mutate: (p: Record<string, unknown>) => unknown) => {
                const row = await (await getDB()).get("items", id);
                if (!row) return null;
                const next = mutate({ ...stored });
                if (next !== null) stored = next as Record<string, unknown>;
                return row;
            },
        );
    });

    it("replaces local: ref with real file id in note HTML", async () => {
        stored = notePayload('<img data-file-id="local:pending-1" alt="x" />').payload;

        const changed = await swapFileRefInNoteContent("note-1", "local:pending-1", "file-real");

        expect(changed).toBe(true);
        expect(stored).toEqual({
            title: "Note",
            contentTitle: "Note",
            content: '<img data-file-id="file-real" alt="x" />',
        });
    });

    it("one attempt: a note that does not store the ref is not written", async () => {
        stored = notePayload("<p>no embed yet</p>").payload;

        expect(await swapFileRefInNoteContent("note-1", "local:a", "file-b", 1)).toBe(false);

        expect(reencryptAndSaveMock).toHaveBeenCalledTimes(1);
        expect(stored.content).toBe("<p>no embed yet</p>");
    });

    it("waits for a save that is still bringing the ref", async () => {
        stored = notePayload("<p></p>").payload;
        setTimeout(() => {
            stored = notePayload('<p><img data-file-id="local:a"></p>').payload;
        }, 250);

        expect(await swapFileRefInNoteContent("note-1", "local:a", "file-b")).toBe(true);

        expect(stored.content).toBe('<p><img data-file-id="file-b"></p>');
    });

    it("returns false when note is missing or not a note", async () => {
        await (await getDB()).clear("items");

        expect(await swapFileRefInNoteContent("note-1", "local:a", "file-b")).toBe(false);
        expect(reencryptAndSaveMock).not.toHaveBeenCalled();
    });
});

describe("removeFileRefsFromNotes", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("items");
        await db.put("items", { id: "note-1", type: "note" } as LocalItem);
    });

    it("strips embedded file refs and returns changed note ids", async () => {
        decryptManyItemPayloadsMock.mockResolvedValue([
            {
                id: "note-1",
                data: notePayload(
                    '<p>keep</p><img data-file-id="file-a" alt="a" /><img data-file-id="file-b" alt="b" />',
                ).payload,
            },
        ]);

        const changed = await removeFileRefsFromNotes(["note-1"], ["file-a"]);

        expect(changed).toEqual(["note-1"]);
        expect(updateItemPayloadMock).toHaveBeenCalledOnce();
        const savedHtml = updateItemPayloadMock.mock.calls[0]?.[2] as string;
        expect(savedHtml).not.toContain('data-file-id="file-a"');
        expect(savedHtml).toContain('data-file-id="file-b"');
    });

    it("returns empty array when no refs match", async () => {
        decryptManyItemPayloadsMock.mockResolvedValue([
            {
                id: "note-1",
                data: notePayload('<img data-file-id="other-file" alt="x" />').payload,
            },
        ]);

        expect(await removeFileRefsFromNotes(["note-1"], ["file-a"])).toEqual([]);
        expect(updateItemPayloadMock).not.toHaveBeenCalled();
    });
});

describe("removeFileRefsEverywhere", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("items");
    });

    it("scans all live notes in IDB", async () => {
        const db = await getDB();
        await db.put("items", {
            id: "note-live",
            type: "note",
            parent_id: null,
            encrypted_payload: "x",
            payload_nonce: "x",
            encrypted_item_key: "x",
            item_key_nonce: "x",
            sort_order: "a",
            version: 1,
            dirty: false,
            localRev: 0,
        } as LocalItem);
        await db.put("items", {
            id: "note-trashed",
            type: "note",
            parent_id: null,
            encrypted_payload: "x",
            payload_nonce: "x",
            encrypted_item_key: "x",
            item_key_nonce: "x",
            sort_order: "b",
            version: 1,
            dirty: false,
            localRev: 0,
            deleted_at: 1,
        } as LocalItem);

        decryptManyItemPayloadsMock.mockResolvedValue([
            { id: "note-live", data: notePayload('<img data-file-id="file-x" alt="x" />').payload },
        ]);

        const changed = await removeFileRefsEverywhere(["file-x"]);

        expect(changed).toEqual(["note-live"]);
        // Batched (query "perf 9"): one decryptManyItemPayloads call covers every candidate note,
        // not one ItemService.getDecryptedItem call per note.
        expect(decryptManyItemPayloadsMock).toHaveBeenCalledOnce();
        const requested = decryptManyItemPayloadsMock.mock.calls[0]?.[0] as Array<{ id: string }>;
        expect(requested.map((i) => i.id)).toEqual(["note-live"]);
    });

    it("opts.includeTrashedNotes covers the deleted notes too", async () => {
        const db = await getDB();
        await db.clear("items");
        await db.put("items", {
            id: "note-live",
            type: "note",
            deleted_at: null,
        } as LocalItem);
        await db.put("items", {
            id: "note-trashed",
            type: "note",
            deleted_at: 1,
        } as LocalItem);

        decryptManyItemPayloadsMock.mockResolvedValue([
            { id: "note-live", data: notePayload('<img data-file-id="file-x" alt="x" />').payload },
            {
                id: "note-trashed",
                data: notePayload('<img data-file-id="file-x" alt="x" />').payload,
            },
        ]);

        const changed = await removeFileRefsEverywhere(["file-x"], { includeTrashedNotes: true });

        expect(changed).toEqual(["note-live", "note-trashed"]);
        expect(decryptManyItemPayloadsMock).toHaveBeenCalledOnce();
    });
});

describe("cleanupOrphanedFileRefs", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("items");
    });

    it("dispatches the event, strips the file from live and trashed notes, and calls emitNotesChanged", async () => {
        const db = await getDB();
        await db.put("items", { id: "n1", type: "note", deleted_at: null } as LocalItem);
        await db.put("items", { id: "n2", type: "note", deleted_at: 1 } as LocalItem); // trashed

        decryptManyItemPayloadsMock.mockResolvedValue([
            { id: "n1", data: notePayload('<img data-file-id="f1" alt="x" />').payload },
            { id: "n2", data: notePayload('<img data-file-id="f1" alt="x" />').payload },
        ]);

        const dispatchSpy = vi.spyOn(document, "dispatchEvent");

        const changed = await cleanupOrphanedFileRefs(["f1"]);

        expect(changed).toEqual(["n1", "n2"]);
        // Batched (query "perf 9"): one decryptManyItemPayloads call, not one per note.
        expect(decryptManyItemPayloadsMock).toHaveBeenCalledOnce();

        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        const eventArg = dispatchSpy.mock.calls[0]?.[0] as CustomEvent;
        expect(eventArg.type).toBe(APP_EVENTS.encfileDelete);
        expect(eventArg.detail).toEqual({ fileId: "f1", silent: true });

        expect(emitNotesChanged).toHaveBeenCalledWith(["n1", "n2"]);

        // The order: the event, then the strip, then the emit
        const dispatchOrder = dispatchSpy.mock.invocationCallOrder[0];
        const decryptOrder = decryptManyItemPayloadsMock.mock.invocationCallOrder[0];
        const emitOrder = vi.mocked(emitNotesChanged).mock.invocationCallOrder[0];

        expect(dispatchOrder).toBeLessThan(decryptOrder);
        expect(decryptOrder).toBeLessThan(emitOrder);
    });
});
describe("moveFileEmbedBetweenNotes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("delegates to FileService.move (reparent + embed)", async () => {
        await moveFileEmbedBetweenNotes(
            "file-1",
            "note-src",
            "note-dst",
            "doc.pdf",
            "application/pdf",
        );

        expect(fileServiceMoveMock).toHaveBeenCalledWith(
            "file-1",
            "note-dst",
            "doc.pdf",
            "application/pdf",
        );
    });

    it("no-ops when source and target are the same note", async () => {
        await moveFileEmbedBetweenNotes("file-1", "note-1", "note-1", "doc.pdf");
        expect(fileServiceMoveMock).not.toHaveBeenCalled();
    });
});
