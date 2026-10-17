import "fake-indexeddb/auto";
import type { HistorySnapshot, NotePayload } from "@zknotes/shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { createSnapshotMock } = vi.hoisted(() => ({
    createSnapshotMock: vi.fn().mockResolvedValue({ id: "snap-1" }),
}));

vi.mock("$lib/core/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("$lib/core/api")>();
    return { ...actual, createSnapshot: createSnapshotMock };
});

// decryptSnapshot runs against the real crypto worker, in-process: the Item Key unwrap and the
// payload tag below are the production AAD checks, not a mock's idea of them.
vi.mock("$lib/core/workers/crypto-rpc", async (importOriginal) => {
    const rpc = await importOriginal<typeof import("$lib/core/workers/crypto-rpc")>();
    const { loadInProcessCryptoWorker } = await import("$lib/core/workers/crypto-worker.testkit");
    const worker = new rpc.CryptoWorkerClient(await loadInProcessCryptoWorker());
    return {
        ...rpc,
        unlockWorker: (vaultKey: Uint8Array) => worker.unlock(vaultKey),
        encryptPayloadTask: (itemId: string, data: unknown, version: number) =>
            worker.encryptPayload(itemId, data, version),
        encryptPayloadWithNewKeyTask: (itemId: string, data: unknown, version: number) =>
            worker.encryptPayloadWithNewKey(itemId, data, version),
        decryptPayloadWithKeyTask: (...args: Parameters<typeof rpc.decryptPayloadWithKeyTask>) =>
            worker.decryptPayloadWithKey(...args),
    };
});

import { decryptItemPayload, encryptItemPayloadToBase64 } from "$lib/core/crypto/item-codec";
import { getDB, type LocalItem } from "$lib/core/db";
import { toBase64 } from "$lib/core/utils/base64";
import { encryptPayloadWithNewKeyTask, unlockWorker } from "$lib/core/workers/crypto-rpc";
import { decryptSnapshot, maybeCreateSnapshot } from "./history";

function noteItem(overrides: Partial<LocalItem> = {}): LocalItem {
    return {
        id: "note-1",
        type: "note",
        parent_id: null,
        encrypted_payload: "enc",
        payload_nonce: "nonce",
        encrypted_item_key: "ik",
        item_key_nonce: "ikn",
        sort_order: "m",
        version: 3,
        dirty: false,
        localRev: 1,
        ...overrides,
    } as LocalItem;
}

describe("history", () => {
    beforeEach(async () => {
        createSnapshotMock.mockClear();
        const db = await getDB();
        await db.clear("items");
        await db.clear("metadata");
    });

    it("maybeCreateSnapshot skips when localRev unchanged since last snapshot", async () => {
        const db = await getDB();
        await db.put("items", noteItem({ localRev: 2 }));
        await db.put(
            "metadata",
            { localRevAtLastSnapshot: 2, lastSnapshotAt: 0 },
            "history_meta:note-1",
        );

        await maybeCreateSnapshot("note-1");

        expect(createSnapshotMock).not.toHaveBeenCalled();
    });

    it("maybeCreateSnapshot creates snapshot when localRev advanced", async () => {
        const db = await getDB();
        await db.put("items", noteItem({ localRev: 3, version: 4 }));
        await db.put(
            "metadata",
            { localRevAtLastSnapshot: 1, lastSnapshotAt: 0 },
            "history_meta:note-1",
        );

        await maybeCreateSnapshot("note-1");

        expect(createSnapshotMock).toHaveBeenCalledOnce();
        expect(createSnapshotMock).toHaveBeenCalledWith(
            expect.objectContaining({
                item_id: "note-1",
                item_version_at_snapshot: 4,
            }),
        );
        const meta = await db.get("metadata", "history_meta:note-1");
        expect(meta).toEqual({ localRevAtLastSnapshot: 3, lastSnapshotAt: expect.any(Number) });
    });

    it("createSnapshot fail does not advance meta (retry possible)", async () => {
        createSnapshotMock.mockRejectedValueOnce(new Error("offline"));
        const db = await getDB();
        const oldMeta = { localRevAtLastSnapshot: 1, lastSnapshotAt: 42 };
        await db.put("items", noteItem({ localRev: 2 }));
        await db.put("metadata", oldMeta, "history_meta:note-1");

        await maybeCreateSnapshot("note-1");

        // The meta is written only after a success — a failure leaves the old meta and the next call retries.
        const meta = await db.get("metadata", "history_meta:note-1");
        expect(meta).toEqual(oldMeta);
        expect(createSnapshotMock).toHaveBeenCalledOnce();
    });
});

describe("decryptSnapshot binds the snapshot to the note being viewed", () => {
    const NOTE_A = "0192f000-0000-7000-8000-00000000000a";
    const NOTE_B = "0192f000-0000-7000-8000-00000000000b";
    let snapshotOfA: HistorySnapshot;
    let snapshotOfB: HistorySnapshot;

    /** A snapshot as the server stores it: the item's own ciphertext and wrapped Item Key. */
    async function genuineSnapshot(
        itemId: string,
        content: string,
        version: number,
    ): Promise<HistorySnapshot> {
        const payload: NotePayload = { title: content, contentTitle: content, content };
        const enc = await encryptPayloadWithNewKeyTask(itemId, payload, version);
        return {
            id: crypto.randomUUID(),
            item_id: itemId,
            encrypted_payload: toBase64(enc.ciphertext),
            payload_nonce: toBase64(enc.nonce),
            encrypted_item_key: toBase64(enc.encryptedItemKey),
            item_key_nonce: toBase64(enc.itemKeyNonce),
            item_version_at_snapshot: version,
            created_at: 1,
        };
    }

    beforeAll(async () => {
        await unlockWorker(crypto.getRandomValues(new Uint8Array(32)));
        snapshotOfA = await genuineSnapshot(NOTE_A, "<p>A, three versions ago</p>", 3);
        snapshotOfB = await genuineSnapshot(NOTE_B, "<p>B, never meant for A</p>", 5);
    });

    it("decrypts the note's own snapshot", async () => {
        const payload = await decryptSnapshot<NotePayload>(NOTE_A, snapshotOfA);
        expect(payload.content).toBe("<p>A, three versions ago</p>");
    });

    it("refuses another note's snapshot listed in this note's history", async () => {
        // B's genuine snapshot (B's ciphertext, B's wrapped Item Key, item_id = B) is internally
        // consistent: decrypted under the id the server supplied it would succeed, and Restore
        // would write B's content into A.
        await expect(decryptSnapshot(NOTE_A, snapshotOfB)).rejects.toThrow(
            "Snapshot belongs to a different item",
        );
    });

    it("refuses another note's snapshot relabelled with this note's id", async () => {
        const relabelled = { ...snapshotOfB, item_id: NOTE_A };
        // B's Item Key was wrapped under the AAD "B", so unwrapping it as A fails the tag check.
        await expect(decryptSnapshot(NOTE_A, relabelled)).rejects.toThrow("invalid tag");
    });

    it("a refused snapshot leaves the note's cached Item Key untouched", async () => {
        await decryptSnapshot(NOTE_A, snapshotOfB).catch(() => {});
        await decryptSnapshot(NOTE_A, { ...snapshotOfB, item_id: NOTE_A }).catch(() => {});

        // A fresh save of A is encrypted under whatever the worker caches for A; it must still be
        // A's own key, the one A's wrap unwraps to.
        const saved = await encryptItemPayloadToBase64(NOTE_A, 4, { content: "<p>A today</p>" });
        const reread = await decryptItemPayload<{ content: string }>({
            id: NOTE_A,
            version: 4,
            ...saved,
            encrypted_item_key: snapshotOfA.encrypted_item_key,
            item_key_nonce: snapshotOfA.item_key_nonce,
        });
        expect(reread.content).toBe("<p>A today</p>");
    });
});
