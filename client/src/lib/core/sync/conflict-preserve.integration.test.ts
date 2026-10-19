import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The pull keeps unpushed local text as a conflict copy BEFORE it deletes a row the server purged.
// Both purge branches (the deleted log and the tombstone) used to spell the fail-closed sequence out
// by hand; this pins the one helper they now share: on success the copy is in play and the original
// may go, on failure the original stays, marked for the next sync to retry.

vi.mock("$lib/core/crypto/item-codec", () => ({
    decryptItemPayload: vi.fn(),
    encryptItemPayloadToBase64: vi
        .fn()
        .mockResolvedValue({ encrypted_payload: "enc-b64", payload_nonce: "nonce-b64" }),
}));
vi.mock("$lib/core/search", () => ({
    addOrUpdateDoc: vi.fn().mockResolvedValue(undefined),
    removeDoc: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/core/workers/crypto-rpc", () => ({
    generateItemKeyTask: vi.fn().mockResolvedValue({
        encryptedItemKey: new Uint8Array([1, 2, 3]),
        itemKeyNonce: new Uint8Array([4, 5, 6]),
    }),
    addCachedItemKey: vi.fn().mockResolvedValue(undefined),
    cloneItemKeyTask: vi.fn().mockResolvedValue({
        encryptedItemKey: new Uint8Array([7, 8, 9]),
        itemKeyNonce: new Uint8Array([10, 11, 12]),
    }),
}));
vi.mock("./outbox", () => ({
    enqueueMutation: vi.fn().mockResolvedValue(undefined),
    touchForPush: vi.fn(),
}));
vi.mock("$lib/core/stores/conflict-store.svelte", () => ({
    conflictStore: { add: vi.fn(), removeResolved: vi.fn(), loadAllConflicts: vi.fn() },
}));

import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import { getDB, type LocalItem } from "$lib/core/db";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { preserveDirtyRowAsConflictCopy } from "./conflict";
import { enqueueMutation } from "./outbox";

const mockedDecrypt = vi.mocked(decryptItemPayload);

function dirtyNote(): LocalItem {
    return {
        id: "note-1",
        type: "note",
        parent_id: null,
        sort_order: "a0",
        version: 3,
        encrypted_payload: "cipher",
        payload_nonce: "nonce",
        encrypted_item_key: "key",
        item_key_nonce: "key-nonce",
        dirty: true,
        localRev: 2,
        created_at: 1,
        updated_at: 2,
    } as LocalItem;
}

beforeEach(async () => {
    vi.clearAllMocks();
    const db = await getDB();
    await db.clear("items");
    await db.clear("mutation-queue");
    vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("preserveDirtyRowAsConflictCopy", () => {
    it("on success the copy is stored, queued and in the inbox, and the original may go", async () => {
        mockedDecrypt.mockResolvedValue({ title: "Plan", content: "<p>offline text</p>" });
        const db = await getDB();
        const local = dirtyNote();
        await db.put("items", local);

        expect(await preserveDirtyRowAsConflictCopy(db, local)).toBe(true);

        const rows = await db.getAll("items");
        const copy = rows.find((r) => r.id !== local.id);
        expect(copy?.conflict_of).toBe(local.id);
        expect(copy?.dirty).toBe(true);
        expect(enqueueMutation).toHaveBeenCalledWith(copy?.id, "upsert");
        expect(conflictStore.add).toHaveBeenCalledWith(
            expect.objectContaining({ id: copy?.id, type: "note" }),
        );
        expect(local.sync_error).toBeUndefined();
    });

    it("on failure the original stays, marked pending_purge_conflict, and nothing is queued", async () => {
        mockedDecrypt.mockRejectedValue(new Error("worker locked"));
        const db = await getDB();
        const local = dirtyNote();
        await db.put("items", local);

        expect(await preserveDirtyRowAsConflictCopy(db, local)).toBe(false);

        const stored = await db.get("items", local.id);
        expect(stored?.sync_error).toBe("pending_purge_conflict");
        expect(await db.getAll("items")).toHaveLength(1);
        expect(enqueueMutation).not.toHaveBeenCalled();
        expect(conflictStore.add).not.toHaveBeenCalled();
    });

    it("does not overwrite an earlier sync_error on repeated failure", async () => {
        mockedDecrypt.mockRejectedValue(new Error("still locked"));
        const db = await getDB();
        const local = { ...dirtyNote(), sync_error: "Permanent push error" } as LocalItem;
        await db.put("items", local);
        expect(await preserveDirtyRowAsConflictCopy(db, local)).toBe(false);
        expect((await db.get("items", local.id))?.sync_error).toBe("Permanent push error");
    });
});
