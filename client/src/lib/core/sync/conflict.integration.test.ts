import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the crypto, worker and search dependencies; the base64 and tiptap utils stay real (they are pure).
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
vi.mock("./outbox", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    enqueueMutation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/core/stores/conflict-store.svelte", () => ({
    conflictStore: { add: vi.fn(), removeResolved: vi.fn(), loadAllConflicts: vi.fn() },
}));

import { decryptItemPayload, encryptItemPayloadToBase64 } from "$lib/core/crypto/item-codec";
import { getDB, type LocalItem } from "$lib/core/db";
import { removeDoc } from "$lib/core/search";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { toBase64 } from "$lib/core/utils/base64";
import {
    addCachedItemKey,
    cloneItemKeyTask,
    generateItemKeyTask,
} from "$lib/core/workers/crypto-rpc";
import {
    createLocalConflictCopy,
    createLocalFileConflictCopy,
    isConflictIdentical,
    replaceConflictCopyContent,
    resolveConflictInDB,
    stripConflictSuffix,
} from "./conflict";
import { enqueueMutation } from "./outbox";

const mockedDecrypt = vi.mocked(decryptItemPayload);
const mockedEncrypt = vi.mocked(encryptItemPayloadToBase64);
const mockedGenKey = vi.mocked(generateItemKeyTask);
const mockedAddCached = vi.mocked(addCachedItemKey);
const mockedCloneKey = vi.mocked(cloneItemKeyTask);
const mockedEnqueue = vi.mocked(enqueueMutation);
const mockedRemoveDoc = vi.mocked(removeDoc);
const mockedRemoveResolved = vi.mocked(conflictStore.removeResolved);

beforeEach(async () => {
    vi.clearAllMocks();
    const db = await getDB();
    await db.clear("items");
    await db.clear("mutation-queue");
});

function noteItem(): LocalItem {
    return {
        id: "orig-note",
        type: "note",
        parent_id: "p1",
        encrypted_payload: "x",
        payload_nonce: "n",
        encrypted_item_key: "AAAA",
        item_key_nonce: "BBBB",
        sort_order: "m",
        version: 4,
        dirty: false,
    } as LocalItem;
}

function fileItem(): LocalItem {
    return {
        id: "orig-file",
        type: "file",
        parent_id: "p1",
        encrypted_payload: "x",
        payload_nonce: "n",
        encrypted_item_key: "AAAA",
        item_key_nonce: "BBBB",
        chunk_set_id: "cs-1",
        chunk_count: 3,
        ciphertext_size: 999,
        sort_order: "m",
        version: 4,
        dirty: false,
    } as LocalItem;
}

describe("createLocalConflictCopy (note)", () => {
    it("prefixes title, mints a NEW item key, injects conflict_of in payload, returns { item, title }", async () => {
        mockedDecrypt.mockResolvedValue({
            title: "My Note",
            content: '<p>x</p><img data-file-id="file-1" alt="a" />',
        });

        // The parent has to exist locally for it to be kept (otherwise null)
        const db = await getDB();
        await db.put("items", {
            id: "p1",
            type: "folder",
            parent_id: null,
            encrypted_payload: "x",
            payload_nonce: "n",
            encrypted_item_key: "k",
            item_key_nonce: "kn",
            sort_order: "a",
            version: 1,
            dirty: false,
        } as LocalItem);

        const orig = noteItem();
        const { item, title } = await createLocalConflictCopy(orig);

        expect(title).toMatch(/^My Note \[Conflict /);
        expect(item.id).not.toBe("orig-note"); // a new uuid
        expect(item.type).toBe("note");
        expect(item.version).toBe(1);
        expect(item.dirty).toBe(true);
        expect(item.parent_id).toBe("p1"); // it keeps its position when the parent exists
        expect(item.conflict_of).toBe(orig.id); // a plaintext column
        expect(mockedGenKey).toHaveBeenCalledTimes(1); // re-key for the note
        expect(mockedAddCached).not.toHaveBeenCalled();
        // The payload sent for encryption should carry the conflict_of marker
        const encryptedPayload = mockedEncrypt.mock.calls[0]?.[2] as Record<string, unknown>;
        expect(encryptedPayload?.conflict_of).toBe(orig.id);
        expect(encryptedPayload?.content as string).not.toContain("data-file-id");
        expect(encryptedPayload?.content as string).toContain("<p>x</p>");
    });

    it("parent_id is null when the parent does not exist locally", async () => {
        mockedDecrypt.mockResolvedValue({ title: "Orphan", content: "<p>y</p>" });
        const orig = noteItem(); // parent_id p1 is not in IDB
        const { item } = await createLocalConflictCopy(orig);
        expect(item.parent_id).toBeNull();
    });
});

describe("createLocalFileConflictCopy (file)", () => {
    it("prefixes name, SHARES chunk set + item key (no re-key), injects conflict_of, returns { item, title }", async () => {
        mockedDecrypt.mockResolvedValue({ name: "photo.png" });

        const orig = fileItem();
        const { item, title } = await createLocalFileConflictCopy(orig);

        expect(title).toMatch(/^photo\.png \[Conflict /);
        expect(item.id).not.toBe("orig-file");
        expect(item.type).toBe("file");
        // It shares the blob and the key — it does NOT re-key
        expect(item.chunk_set_id).toBe(orig.chunk_set_id);
        expect(item.chunk_count).toBe(orig.chunk_count);
        expect(item.ciphertext_size).toBe(orig.ciphertext_size);
        // Re-wrapped under the new id — NOT the same wire wrap as the original
        expect(item.encrypted_item_key).toBe(toBase64(new Uint8Array([7, 8, 9])));
        expect(item.item_key_nonce).toBe(toBase64(new Uint8Array([10, 11, 12])));
        expect(item.conflict_of).toBe(orig.id); // a plaintext column
        expect(mockedGenKey).not.toHaveBeenCalled(); // no new raw key
        expect(mockedAddCached).not.toHaveBeenCalled();
        expect(mockedCloneKey).toHaveBeenCalledTimes(1);
        expect(mockedCloneKey).toHaveBeenCalledWith(
            orig.id,
            item.id,
            expect.any(Uint8Array),
            expect.any(Uint8Array),
        );
        // The payload sent for encryption should carry the conflict_of marker
        const encryptedPayload = mockedEncrypt.mock.calls[0]?.[2] as Record<string, unknown>;
        expect(encryptedPayload?.conflict_of).toBe(orig.id);
    });
});

// ---------------------------------------------------------------------------
//  stripConflictSuffix
// ---------------------------------------------------------------------------

describe("replaceConflictCopyContent (one conflict, one copy)", () => {
    async function seedCopy(over: Partial<LocalItem> = {}): Promise<void> {
        const db = await getDB();
        await db.put("items", {
            id: "copy-1",
            type: "note",
            parent_id: null,
            encrypted_payload: "copy-enc",
            payload_nonce: "copy-n",
            encrypted_item_key: "AAAA",
            item_key_nonce: "BBBB",
            sort_order: "m",
            version: 1,
            dirty: false,
            localRev: 2,
            conflict_of: "orig-note",
            ...over,
        } as LocalItem);
        mockedDecrypt.mockResolvedValue({
            title: "My Note [Conflict 2026-09-29 10:00]",
            contentTitle: "My Note",
            content: "<p>saved</p>",
            conflict_of: "orig-note",
            starred: true,
        });
    }

    it("puts the new content into the copy under ITS key, keeping the conflict title and the rest", async () => {
        await seedCopy();

        const res = await replaceConflictCopyContent(
            "copy-1",
            "orig-note",
            "My Note",
            '<p>saved and typed</p><img data-file-id="file-1" alt="a" />',
        );

        expect(res).toBe("written");
        expect(mockedGenKey).not.toHaveBeenCalled();
        expect(mockedAddCached).toHaveBeenCalledWith(
            "copy-1",
            expect.any(Uint8Array),
            expect.any(Uint8Array),
        );
        const [id, version, payload] = mockedEncrypt.mock.calls[0] ?? [];
        expect(id).toBe("copy-1");
        expect(version).toBe(1);
        expect(payload).toMatchObject({
            title: "My Note [Conflict 2026-09-29 10:00]",
            contentTitle: "My Note",
            conflict_of: "orig-note",
            starred: true,
        });
        // The embed is stripped, as when the copy was made (a sibling must not share a file).
        expect((payload as { content: string }).content).toContain("saved and typed");
        expect((payload as { content: string }).content).not.toContain("file-1");
        const stored = await (await getDB()).get("items", "copy-1");
        expect(stored?.encrypted_payload).toBe("enc-b64");
        expect(stored?.dirty).toBe(true);
        expect(stored?.localRev).toBe(3);
        expect(mockedEnqueue).toHaveBeenCalledWith("copy-1", "upsert");
    });

    it("does nothing when the copy already holds that content", async () => {
        await seedCopy();
        const res = await replaceConflictCopyContent(
            "copy-1",
            "orig-note",
            "My Note",
            "<p>saved</p>",
        );
        expect(res).toBe("unchanged");
        expect(mockedEncrypt).not.toHaveBeenCalled();
        expect((await (await getDB()).get("items", "copy-1"))?.encrypted_payload).toBe("copy-enc");
    });

    it("is unavailable when the copy is gone, resolved, trashed or belongs to another note", async () => {
        expect(await replaceConflictCopyContent("copy-1", "orig-note", "T", "<p>x</p>")).toBe(
            "unavailable",
        );
        await seedCopy({ conflict_of: undefined });
        expect(await replaceConflictCopyContent("copy-1", "orig-note", "T", "<p>x</p>")).toBe(
            "unavailable",
        );
        await seedCopy({ deleted_at: 5 });
        expect(await replaceConflictCopyContent("copy-1", "orig-note", "T", "<p>x</p>")).toBe(
            "unavailable",
        );
        await seedCopy();
        expect(await replaceConflictCopyContent("copy-1", "other-note", "T", "<p>x</p>")).toBe(
            "unavailable",
        );
        expect(mockedEncrypt).not.toHaveBeenCalled();
    });

    it("is unavailable, and writes nothing, when the copy changed during the encrypt", async () => {
        await seedCopy();
        mockedEncrypt.mockImplementationOnce(async () => {
            const db = await getDB();
            const row = await db.get("items", "copy-1");
            if (row) {
                row.encrypted_payload = "resolved-meanwhile";
                await db.put("items", row);
            }
            return { encrypted_payload: "enc-b64", payload_nonce: "nonce-b64" };
        });

        const res = await replaceConflictCopyContent("copy-1", "orig-note", "T", "<p>new</p>");

        expect(res).toBe("unavailable");
        expect((await (await getDB()).get("items", "copy-1"))?.encrypted_payload).toBe(
            "resolved-meanwhile",
        );
        expect(mockedEnqueue).not.toHaveBeenCalled();
    });
});

describe("stripConflictSuffix", () => {
    it("strips the suffix the create helpers generate", () => {
        expect(stripConflictSuffix("My Note [Conflict 2026-06-26 14:30]")).toBe("My Note");
    });
    it("is idempotent on clean titles", () => {
        expect(stripConflictSuffix("Clean Title")).toBe("Clean Title");
    });
    it("leaves it alone when the format does not match exactly (it should not match)", () => {
        expect(stripConflictSuffix("Title [Conflict 26-6-2026]")).toBe(
            "Title [Conflict 26-6-2026]",
        );
    });
    it("an empty string does not throw", () => {
        expect(stripConflictSuffix("")).toBe("");
    });
});

// ---------------------------------------------------------------------------
//  resolveConflictInDB
// ---------------------------------------------------------------------------

async function seedCopy(over: Partial<LocalItem> & { id: string }): Promise<void> {
    const db = await getDB();
    await db.put("items", {
        type: "note" as const,
        parent_id: null,
        encrypted_payload: "cp",
        payload_nonce: "np",
        encrypted_item_key: "ik",
        item_key_nonce: "ikn",
        sort_order: "m",
        version: 2,
        dirty: false,
        localRev: 0,
        conflict_of: "orig-1",
        ...over,
    } as LocalItem);
}

async function seedOriginal(id: string): Promise<void> {
    const db = await getDB();
    await db.put("items", {
        id,
        type: "note" as const,
        parent_id: null,
        encrypted_payload: "op",
        payload_nonce: "onp",
        encrypted_item_key: "oik",
        item_key_nonce: "oikn",
        sort_order: "a",
        version: 5,
        dirty: false,
        localRev: 0,
    } as LocalItem);
}

describe("resolveConflictInDB — keep_server", () => {
    it("deletes the copy locally and enqueues a server delete, without enqueuing an upsert", async () => {
        await seedCopy({ id: "copy-1" });

        await resolveConflictInDB("copy-1", "orig-1", "keep_server");

        const db = await getDB();
        expect(await db.get("items", "copy-1")).toBeUndefined(); // deleted locally
        expect(mockedRemoveDoc).toHaveBeenCalledWith("copy-1");
        expect(mockedEnqueue).toHaveBeenCalledWith("copy-1", "delete");
        expect(mockedEnqueue).not.toHaveBeenCalledWith("copy-1", "upsert");
        expect(mockedRemoveResolved).toHaveBeenCalledWith("copy-1");
        // No re-encryption
        expect(mockedEncrypt).not.toHaveBeenCalled();
    });
});

describe("resolveConflictInDB — keep_local (merge-back)", () => {
    it("writes the offline content into the ORIGINAL under its own Item Key, deletes the copy, and enqueues an original upsert plus a copy delete", async () => {
        // 1) the copy's payload, 2) the original's payload (for reattaching the embeds — no file refs here)
        mockedDecrypt
            .mockResolvedValueOnce({
                title: "Note [Conflict 2026-06-26 14:30]",
                content: "<p>offline</p>",
                conflict_of: "orig-1",
            })
            .mockResolvedValueOnce({
                title: "Note",
                content: "<p>server</p>",
            });
        await seedCopy({ id: "copy-2" });
        await seedOriginal("orig-1");

        await resolveConflictInDB("copy-2", "orig-1", "keep_local");

        // Re-encryption under the ORIGINAL's id and key, not the copy's, with no marker and the suffix dropped.
        expect(mockedEncrypt).toHaveBeenCalledTimes(1);
        expect(mockedGenKey).not.toHaveBeenCalled();
        expect(mockedEncrypt.mock.calls[0]?.[0]).toBe("orig-1"); // encrypts under the original
        // The original's wrapped key is cached before encrypting (the copy and the original have different IKs).
        expect(mockedAddCached).toHaveBeenCalled();
        const reEncPayload = mockedEncrypt.mock.calls[0]?.[2] as Record<string, unknown>;
        expect(reEncPayload.conflict_of).toBeUndefined(); // the marker is gone
        expect(reEncPayload.title).toBe("Note"); // the suffix is stripped

        const db = await getDB();
        // The copy is deleted locally (its content now lives in the original)
        expect(await db.get("items", "copy-2")).toBeUndefined();

        // The original carries the new ciphertext, is dirty, and is NOT trashed (a stable identity)
        const orig = await db.get("items", "orig-1");
        expect(orig?.encrypted_payload).toBe("enc-b64");
        expect(orig?.dirty).toBe(true);
        expect(orig?.deleted_at).toBeUndefined();

        expect(mockedEnqueue).toHaveBeenCalledWith("orig-1", "upsert");
        expect(mockedEnqueue).toHaveBeenCalledWith("copy-2", "delete");
        expect(mockedRemoveDoc).toHaveBeenCalledWith("copy-2");
        expect(mockedRemoveResolved).toHaveBeenCalledWith("copy-2");
    });

    it("keep_local on a note with attachments restores the encFile embeds from the original, deleting no attachments", async () => {
        mockedDecrypt
            .mockResolvedValueOnce({
                title: "Note [Conflict 2026-06-26 14:30]",
                // The conflict copy is stripped (createLocalConflictCopy)
                content: "<p>offline edit</p>",
                conflict_of: "orig-1",
            })
            .mockResolvedValueOnce({
                title: "Note",
                content:
                    '<p>server</p><img data-file-id="file-1" alt="photo" data-mime="image/png" />',
            });
        await seedCopy({ id: "copy-embed", type: "note" });
        await seedOriginal("orig-1");

        await resolveConflictInDB("copy-embed", "orig-1", "keep_local");

        const reEncPayload = mockedEncrypt.mock.calls[0]?.[2] as Record<string, unknown>;
        expect(reEncPayload.content as string).toContain("offline edit");
        expect(reEncPayload.content as string).toContain('data-file-id="file-1"');
        expect(reEncPayload.content as string).toContain("photo");
    });

    it("file merge-back copies chunk_set_id/chunk_count/ciphertext_size from the copy onto the original", async () => {
        // While the copy waited for resolution, the original received a NEWER chunk set from another
        // device (a content replace, say) — the server-side chunk_set_id diverged from what the copy's
        // payload manifest (chunkSetId/chunks) describes. Without propagating the DB metadata
        // the original would, after the merge-back, hold a payload referencing one blob (the copy's)
        // while item.chunk_set_id pointed at another — the payload and the row would disagree about
        // which blob the file is.
        mockedDecrypt.mockResolvedValue({
            name: "photo [Conflict 2026-06-26 14:30]",
            kind: "file",
            chunkSetId: "cs-old",
            conflict_of: "orig-file-1",
        });
        await seedCopy({
            id: "copy-file-1",
            type: "file",
            chunk_set_id: "cs-old",
            chunk_count: 3,
            ciphertext_size: 999,
        });
        const db = await getDB();
        await db.put("items", {
            id: "orig-file-1",
            type: "file",
            parent_id: null,
            encrypted_payload: "op",
            payload_nonce: "onp",
            encrypted_item_key: "oik",
            item_key_nonce: "oikn",
            chunk_set_id: "cs-new",
            chunk_count: 7,
            ciphertext_size: 5555,
            sort_order: "a",
            version: 5,
            dirty: false,
            localRev: 0,
        } as LocalItem);

        await resolveConflictInDB("copy-file-1", "orig-file-1", "keep_local");

        const orig = await db.get("items", "orig-file-1");
        expect(orig?.chunk_set_id).toBe("cs-old");
        expect(orig?.chunk_count).toBe(3);
        expect(orig?.ciphertext_size).toBe(999);
    });

    it("the fallback with no live original: promote the copy to the canonical item, dropping the suffix", async () => {
        mockedDecrypt.mockResolvedValue({
            title: "Note [Conflict 2026-06-26 14:30]",
            conflict_of: "orig-1",
        });
        await seedCopy({ id: "copy-2b" });
        // Do NOT seed the original → a merge-back is impossible

        await resolveConflictInDB("copy-2b", "orig-1", "keep_local");

        // Re-encryption under the COPY's id, the suffix stripped, and the original left alone
        expect(mockedEncrypt.mock.calls[0]?.[0]).toBe("copy-2b");
        const reEncPayload = mockedEncrypt.mock.calls[0]?.[2] as Record<string, unknown>;
        expect(reEncPayload.title).toBe("Note");

        const db = await getDB();
        const stored = await db.get("items", "copy-2b");
        expect(stored?.conflict_of).toBeUndefined();
        expect(stored?.dirty).toBe(true);

        expect(mockedEnqueue).toHaveBeenCalledWith("copy-2b", "upsert");
        expect(mockedEnqueue).not.toHaveBeenCalledWith("orig-1", "delete");
        expect(mockedRemoveResolved).toHaveBeenCalledWith("copy-2b");
    });
});

describe("isConflictIdentical (deduplication)", () => {
    it("note: an identical title, description and content → true", async () => {
        const payload = { title: "T", description: "D", content: "C" };
        mockedDecrypt.mockResolvedValueOnce(payload).mockResolvedValueOnce(payload);
        const local = noteItem();
        const server = { ...noteItem(), version: 9 };

        expect(await isConflictIdentical(local, server)).toBe(true);
    });

    it("note: different content → false", async () => {
        mockedDecrypt
            .mockResolvedValueOnce({ title: "T", description: "D", content: "LOCAL" })
            .mockResolvedValueOnce({ title: "T", description: "D", content: "SERVER" });

        expect(await isConflictIdentical(noteItem(), noteItem())).toBe(false);
    });

    it("note: the same content but a different deleted_at → false (a trash must not disappear)", async () => {
        const payload = { title: "T", content: "C" };
        mockedDecrypt.mockResolvedValueOnce(payload).mockResolvedValueOnce(payload);
        const local = { ...noteItem(), deleted_at: 1000 } as LocalItem;
        const server = { ...noteItem(), deleted_at: null, version: 9 } as LocalItem;

        expect(await isConflictIdentical(local, server)).toBe(false);
    });

    it("note: the same content but a different starred → false", async () => {
        mockedDecrypt.mockReset();
        mockedDecrypt
            .mockResolvedValueOnce({ title: "T", content: "C", starred: true })
            .mockResolvedValueOnce({ title: "T", content: "C", starred: false });

        expect(await isConflictIdentical(noteItem(), noteItem())).toBe(false);
    });

    it("note: the same content but a different parent_id → false (a move)", async () => {
        mockedDecrypt.mockReset();
        const payload = { title: "T", content: "C" };
        mockedDecrypt.mockResolvedValueOnce(payload).mockResolvedValueOnce(payload);
        const local = { ...noteItem(), parent_id: "folder-a" };
        const server = { ...noteItem(), parent_id: "folder-b", version: 9 };

        expect(await isConflictIdentical(local, server)).toBe(false);
    });

    it("file: the same name/mime/chunk_set_id → true", async () => {
        mockedDecrypt.mockReset();
        const payload = { name: "a.pdf", mime: "application/pdf" };
        mockedDecrypt.mockResolvedValueOnce(payload).mockResolvedValueOnce(payload);
        const local = fileItem();
        const server = { ...fileItem(), version: 7 };

        expect(await isConflictIdentical(local, server)).toBe(true);
    });

    it("file: a different chunk_set_id → false", async () => {
        mockedDecrypt.mockReset();
        mockedDecrypt.mockResolvedValue({ name: "a.pdf", mime: "application/pdf" });
        const local = fileItem();
        const server = { ...fileItem(), chunk_set_id: "other-cs" } as LocalItem;

        expect(await isConflictIdentical(local, server)).toBe(false);
    });

    // Regression: the file branch compared only name/mime/chunk_set_id, so a file whose only local
    // change was its description compared as identical — no conflict copy, and the server row
    // overwrote the edit with nothing shown to the user. It is editable in the detail panel and
    // indexed for search, so it is a real edit to lose.
    it("file: the same name/mime but a different description → false", async () => {
        mockedDecrypt.mockReset();
        mockedDecrypt
            .mockResolvedValueOnce({
                name: "a.pdf",
                mime: "application/pdf",
                description: "LOCAL",
            })
            .mockResolvedValueOnce({
                name: "a.pdf",
                mime: "application/pdf",
                description: "SERVER",
            });
        const local = fileItem();
        const server = { ...fileItem(), version: 7 };

        expect(await isConflictIdentical(local, server)).toBe(false);
    });

    it("a decrypt failure → false (treated as not equal)", async () => {
        mockedDecrypt.mockReset();
        mockedDecrypt.mockRejectedValue(new Error("vault locked"));

        expect(await isConflictIdentical(noteItem(), noteItem())).toBe(false);
    });
});

describe("resolveConflictInDB — keep_both", () => {
    it("re-encrypts without the marker, KEEPS the suffix, enqueues only an upsert, and leaves the original alone", async () => {
        mockedDecrypt.mockResolvedValue({
            title: "Note [Conflict 2026-06-26 14:30]",
            conflict_of: "orig-1",
        });
        await seedCopy({ id: "copy-3" });
        await seedOriginal("orig-1");

        await resolveConflictInDB("copy-3", "orig-1", "keep_both");

        expect(mockedEncrypt).toHaveBeenCalledTimes(1);
        const reEncPayload = mockedEncrypt.mock.calls[0]?.[2] as Record<string, unknown>;
        expect(reEncPayload.conflict_of).toBeUndefined(); // the marker is gone from the ciphertext
        expect(reEncPayload.title).toBe("Note [Conflict 2026-06-26 14:30]"); // the suffix is kept

        // The plaintext column is gone, the original untouched
        const db = await getDB();
        expect((await db.get("items", "copy-3"))?.conflict_of).toBeUndefined();
        expect((await db.get("items", "orig-1"))?.deleted_at).toBeUndefined();

        expect(mockedEnqueue).toHaveBeenCalledWith("copy-3", "upsert");
        expect(mockedEnqueue).not.toHaveBeenCalledWith("orig-1", expect.anything());
        expect(mockedRemoveResolved).toHaveBeenCalledWith("copy-3");
    });
});
