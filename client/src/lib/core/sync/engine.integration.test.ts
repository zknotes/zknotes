import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock everything but getDB (fake-idb) — we are testing the pull-apply logic (trashed vs purged, restore propagation).
vi.mock("$lib/core/api", () => {
    class ApiError extends Error {
        constructor(
            message: string,
            public readonly status: number,
        ) {
            super(message);
            this.name = "ApiError";
        }
    }
    const pullSince = vi.fn();
    const pullPage = vi.fn(async (opts?: { since: number; cursor?: string | null }) => {
        const page = await pullSince(opts?.since ?? 0);
        return { next_cursor: null, ...(page as object) };
    });
    return {
        ApiError,
        pullSince,
        pullPage,
        pushBatch: vi.fn(),
    };
});
vi.mock("$lib/core/search", () => ({
    addOrUpdateDoc: vi.fn().mockResolvedValue(undefined),
    addOrUpdateDocs: vi.fn().mockResolvedValue(undefined),
    removeDoc: vi.fn().mockResolvedValue(undefined),
    suspendIndexPersistence: vi.fn(),
    resumeIndexPersistenceAndFlush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./conflict", async () => {
    // The copy makers are mocked per test; the two helpers the pull and the retry go through are
    // rebuilt on top of the mocks so the fail-closed sequence stays observable here.
    const { enqueueMutation } = await import("./outbox");
    const { conflictStore } = await import("$lib/core/stores/conflict-store.svelte");
    const createConflictCopyForItem = vi.fn();
    const announceConflictCopy = vi.fn(
        async (
            db: { put: (store: "items", value: unknown) => Promise<unknown> },
            copy: { id: string },
            title: string,
            type: string,
        ) => {
            await db.put("items", copy);
            await enqueueMutation(copy.id, "upsert");
            conflictStore.add({ id: copy.id, title, type: type as "note", at: 0 });
        },
    );
    const preserveDirtyRowAsConflictCopy = vi.fn(
        async (
            db: { put: (store: "items", value: unknown) => Promise<unknown> },
            local: { id: string; type: string; sync_error?: string },
        ) => {
            try {
                const { item, title } = await createConflictCopyForItem(local);
                await announceConflictCopy(db, item, title, local.type);
                return true;
            } catch {
                if (!local.sync_error) {
                    local.sync_error = "pending_purge_conflict";
                    await db.put("items", local);
                }
                return false;
            }
        },
    );
    return {
        createLocalConflictCopy: vi.fn(),
        createConflictCopyForItem,
        isConflictIdentical: vi.fn().mockResolvedValue(false),
        announceConflictCopy,
        preserveDirtyRowAsConflictCopy,
    };
});
vi.mock("./store.svelte", () => ({
    syncStore: {
        markSyncSuccess: vi.fn(),
        markSyncError: vi.fn(),
        refreshPendingCount: vi.fn(),
        noteParkedFailure: vi.fn(),
        beginPush: vi.fn(),
        endPush: vi.fn(),
        isSuspended: false,
    },
}));
vi.mock("$lib/core/stores/conflict-store.svelte", () => ({
    conflictStore: { add: vi.fn() },
}));
vi.mock("$lib/core/events/file-bridge", () => ({
    fileBridge: {
        invalidateFile: vi.fn().mockResolvedValue(undefined),
        cleanupOrphanedFileRefs: vi.fn().mockResolvedValue([]),
    },
}));
const { decryptItemPayloadMock } = vi.hoisted(() => ({
    decryptItemPayloadMock: vi.fn().mockResolvedValue({ title: "x" }),
}));

vi.mock("$lib/core/crypto/item-codec", () => ({
    decryptItemPayload: decryptItemPayloadMock,
    // decryptManyItemPayloads delegates to the same mock so existing per-test
    // decryptItemPayload.mockResolvedValueOnce/mockRejectedValueOnce expectations still drive the
    // batched pull path (one decryptManyItemPayloads call per page replaced the per-item
    // hydrateConflictMarker call).
    decryptManyItemPayloads: vi.fn().mockImplementation(async (items: Array<{ id: string }>) => {
        const results: Array<{ id: string; data?: unknown; error?: string }> = [];
        for (const item of items) {
            try {
                const data = await decryptItemPayloadMock(item);
                results.push({ id: item.id, data });
            } catch (e) {
                results.push({ id: item.id, error: e instanceof Error ? e.message : "error" });
            }
        }
        return results;
    }),
}));

import { FILE_LIMITS } from "@zknotes/shared";
import { ApiError, pullPage, pullSince, pushBatch } from "$lib/core/api";
import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import {
    getDB,
    getPendingMutationCount,
    getWatermark,
    type LocalItem,
    setWatermark,
} from "$lib/core/db";
import { fileBridge } from "$lib/core/events/file-bridge";
import { removeDoc } from "$lib/core/search";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import {
    createConflictCopyForItem,
    createLocalConflictCopy,
    isConflictIdentical,
} from "./conflict";
import {
    enqueueMutation,
    migrateLegacyItems,
    mutationRetryAt,
    nextMutationRetryAt,
    onMutationQueueChanged,
    pullAndMerge,
    pushDeletes,
    pushItem,
    pushPendingMutations,
} from "./engine";
import { syncStore } from "./store.svelte";

const mockedPull = vi.mocked(pullSince);
const mockedPage = vi.mocked(pullPage);
const mockedPush = vi.mocked(pushBatch);
const mockedCreateForItem = vi.mocked(createConflictCopyForItem);
const mockedCreateLocal = vi.mocked(createLocalConflictCopy);
const mockedIsIdentical = vi.mocked(isConflictIdentical);
const mockedConflictAdd = vi.mocked(conflictStore.add);

let seq = 0;
function newId(): string {
    seq += 1;
    return `it-${seq}`;
}

function wireItem(over: Record<string, unknown> & { id: string }) {
    return {
        type: "note",
        parent_id: null,
        encrypted_payload: null,
        payload_nonce: null,
        encrypted_item_key: null,
        item_key_nonce: null,
        version: 2,
        sort_order: "m",
        deleted_at: null,
        purged_at: null,
        created_at: 1,
        updated_at: 2,
        ...over,
    };
}

async function seedLocal(over: Partial<LocalItem> & { id: string }) {
    const db = await getDB();
    await db.put("items", {
        type: "note",
        parent_id: null,
        encrypted_payload: null,
        payload_nonce: null,
        encrypted_item_key: null,
        item_key_nonce: null,
        version: 1,
        sort_order: "m",
        dirty: false,
        localRev: 0,
        ...over,
    } as LocalItem);
}

const get = async (id: string) => (await getDB()).get("items", id);

beforeEach(async () => {
    vi.clearAllMocks();
    const db = await getDB();
    await db.clear("items");
    await db.clear("mutation-queue");
    await setWatermark(0);
    mockedPull.mockResolvedValue({ items: [], deleted: [], server_time: 100 } as never);
});

describe("pullAndMerge — synced trash (7b)", () => {
    it("server TRASHED (deleted_at, no purged_at) → the local row becomes trashed, NOT deleted", async () => {
        const id = newId();
        await seedLocal({ id, version: 1 }); // READY clean
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 2, deleted_at: 1700000000 })],
            deleted: [],
            server_time: 100,
        } as never);

        await pullAndMerge();

        const row = await get(id);
        expect(row).toBeDefined(); // it still exists
        expect(row?.deleted_at).toBe(1700000000); // trashed
    });

    it("the server PURGED it (purged_at) → the local row is deleted from IDB (a tombstone)", async () => {
        const id = newId();
        await seedLocal({ id, version: 1 });
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 2, deleted_at: 1700000000, purged_at: 1700000001 })],
            deleted: [],
            server_time: 100,
        } as never);

        await pullAndMerge();

        expect(await get(id)).toBeUndefined();
    });

    it("a server RESTORE (deleted_at=null) → a locally trashed row is un-trashed (it propagates)", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, deleted_at: 1700000000 }); // trashed locally, clean
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 2, deleted_at: null })],
            deleted: [],
            server_time: 100,
        } as never);

        await pullAndMerge();

        const row = await get(id);
        expect(row).toBeDefined();
        expect(row?.deleted_at ?? null).toBeNull(); // no longer in Trash
    });

    it("a sync_deleted_log entry → the local row is deleted", async () => {
        const id = newId();
        await seedLocal({ id, version: 1 });
        mockedPull.mockResolvedValue({
            items: [],
            deleted: [{ id, deleted_at: 1700000000 }],
            server_time: 100,
        } as never);

        await pullAndMerge();

        expect(await get(id)).toBeUndefined();
    });

    it("a dirty local trash is NOT overwritten by a pull when server.version > local.version", async () => {
        const id = newId();
        await seedLocal({ id, version: 2, dirty: true, deleted_at: 1700000000 });
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 3, deleted_at: null })],
            deleted: [],
            server_time: 100,
        } as never);

        await pullAndMerge();

        const row = await get(id);
        expect(row).toBeDefined();
        expect(row?.deleted_at).toBe(1700000000);
        expect(row?.dirty).toBe(true);
        expect(createLocalConflictCopy).not.toHaveBeenCalled();
    });
});

// The conflict notification. The conflict helpers are mocked (they return { item, title });
// here we test the engine's WIRING: which helper variant is called, whether the copy is saved, and
// whether conflictStore holds the right entry. The real chunk-set sharing and re-key live in
// conflict.test.ts.
function conflictCopy(id: string, type: "note" | "folder" | "file"): LocalItem {
    return {
        id,
        type,
        parent_id: null,
        encrypted_payload: "enc",
        payload_nonce: "n",
        encrypted_item_key: "k",
        item_key_nonce: "kn",
        sort_order: "m",
        version: 1,
        dirty: true,
        ...(type === "file" ? { chunk_set_id: "cs-1", chunk_count: 1, ciphertext_size: 10 } : {}),
    } as LocalItem;
}

describe("conflict notification", () => {
    it("push 409 → conflict copy stored, original gets server version, conflictStore notified", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: true, localRev: 0 });
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [{ id, current_item: { ...wireItem({ id, version: 5 }), user_id: "u" } }],
            errors: [],
        } as never);
        mockedCreateForItem.mockResolvedValue({
            item: conflictCopy("copy-1", "note"),
            title: "Note [Conflict 2026-01-01 00:00]",
        });

        await pushItem({ id } as LocalItem);

        expect(await get("copy-1")).toBeDefined(); // the copy is saved
        const original = await get(id);
        expect(original?.version).toBe(5); // the server version was taken
        expect(original?.dirty).toBe(false);
        expect(mockedConflictAdd).toHaveBeenCalledWith(
            expect.objectContaining({ id: "copy-1", type: "note" }),
        );
    });

    it("push 409 does not clobber a localRev that advanced while the conflict copy was built", async () => {
        const id = newId();
        await seedLocal({
            id,
            version: 5,
            dirty: true,
            localRev: 10,
            encrypted_payload: "local-v10",
        });
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [
                {
                    id,
                    current_item: {
                        ...wireItem({ id, version: 6, encrypted_payload: "server-v6" }),
                        user_id: "u",
                    },
                },
            ],
            errors: [],
        } as never);
        mockedCreateForItem.mockImplementation(async (snap) => {
            const db = await getDB();
            const current = await db.get("items", id);
            if (current) {
                current.localRev = (current.localRev ?? 0) + 1;
                current.encrypted_payload = `local-v${current.localRev}`;
                await db.put("items", current);
            }
            return {
                item: conflictCopy(`copy-from-${snap.localRev}`, "note"),
                title: "Note [Conflict]",
            };
        });

        await pushItem({ id } as LocalItem);

        const original = await get(id);
        // The in-flight edit (localRev 11+) must not be replaced by the server row.
        expect(original?.encrypted_payload).not.toBe("server-v6");
        expect(original?.localRev).toBeGreaterThanOrEqual(11);
        expect(original?.dirty).toBe(true);
        expect(await getPendingMutationCount()).toBeGreaterThanOrEqual(1);
    });

    it("push 409 + identical payload → no conflict copy, server version accepted (dedup)", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: true, localRev: 0 });
        mockedIsIdentical.mockResolvedValueOnce(true);
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [{ id, current_item: { ...wireItem({ id, version: 5 }), user_id: "u" } }],
            errors: [],
        } as never);

        await pushItem({ id } as LocalItem);

        expect(mockedCreateForItem).not.toHaveBeenCalled();
        expect(mockedConflictAdd).not.toHaveBeenCalled();
        const original = await get(id);
        expect(original?.version).toBe(5);
        expect(original?.dirty).toBe(false);
    });

    it("localRev race mid-conflict-copy → main stays server S, conflict from L2 (no version free-pass)", async () => {
        const id = newId();
        await seedLocal({
            id,
            version: 1,
            dirty: true,
            localRev: 0,
            encrypted_payload: "local-L1",
        });
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [
                {
                    id,
                    current_item: {
                        ...wireItem({ id, version: 5, encrypted_payload: "server-S" }),
                        user_id: "u",
                    },
                },
            ],
            errors: [],
        } as never);

        // The first identical(snap,S)=false → create L1; during that create, bump localRev+payload to L2.
        // The second identical(latest,S)=false → create L2. Main has to be S, not L2 with version=5.
        mockedIsIdentical
            .mockResolvedValueOnce(false) // snap vs S
            .mockResolvedValueOnce(false); // latest vs S after race
        mockedCreateForItem.mockImplementation(async (item: LocalItem) => {
            if (item.encrypted_payload === "local-L1") {
                const db = await getDB();
                const cur = await db.get("items", id);
                if (cur) {
                    cur.localRev = 2;
                    cur.encrypted_payload = "local-L2";
                    cur.dirty = true;
                    await db.put("items", cur);
                }
                return {
                    item: conflictCopy("copy-L1", "note"),
                    title: "L1 conflict",
                };
            }
            return {
                item: conflictCopy("copy-L2", "note"),
                title: "L2 conflict",
            };
        });

        await pushItem({ id } as LocalItem);

        const original = await get(id);
        expect(original?.version).toBe(5);
        expect(original?.encrypted_payload).toBe("server-S");
        expect(original?.dirty).toBe(false);
        // The L1 copy must not be kept as the only artifact; the L2 conflict is in the inbox.
        expect(await get("copy-L1")).toBeUndefined();
        expect(await get("copy-L2")).toBeDefined();
        expect(mockedConflictAdd).toHaveBeenCalledWith(
            expect.objectContaining({ id: "copy-L2", type: "note" }),
        );
        // The conflict copy is in the queue; the original (resolved) is not orphan-dirty without S.
        expect(await getPendingMutationCount()).toBeGreaterThanOrEqual(1);
    });

    it("push 409 on file → conflictStore notified with type:file", async () => {
        const id = newId();
        await seedLocal({ id, type: "file", version: 1, dirty: true, localRev: 0 });
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [
                {
                    id,
                    current_item: { ...wireItem({ id, type: "file", version: 3 }), user_id: "u" },
                },
            ],
            errors: [],
        } as never);
        mockedCreateForItem.mockResolvedValue({
            item: conflictCopy("copy-f", "file"),
            title: "file [Conflict 2026-01-01 00:00]",
        });

        await pushItem({ id } as LocalItem);

        expect(await get("copy-f")).toBeDefined();
        expect(mockedConflictAdd).toHaveBeenCalledWith(
            expect.objectContaining({ id: "copy-f", type: "file" }),
        );
    });

    it("pull purged_at tombstone + local dirty → conflict copy + conflictStore notified", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: true });
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 2, purged_at: 1700000001 })],
            deleted: [],
            server_time: 100,
        } as never);
        mockedCreateForItem.mockResolvedValue({
            item: conflictCopy("copy-2", "note"),
            title: "Note [Conflict 2026-01-01 00:00]",
        });

        await pullAndMerge();

        expect(await get(id)).toBeUndefined(); // the tombstone was deleted
        expect(await get("copy-2")).toBeDefined();
        expect(mockedCreateForItem).toHaveBeenCalled();
        expect(mockedConflictAdd).toHaveBeenCalledWith(
            expect.objectContaining({ id: "copy-2", type: "note" }),
        );
    });

    it("pull deleted-log + local dirty (note) → conflict copy + conflictStore notified", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: true });
        mockedPull.mockResolvedValue({
            items: [],
            deleted: [{ id, deleted_at: 1700000000 }],
            server_time: 100,
        } as never);
        // The deleted-log path now uses createConflictCopyForItem (the same as purged_at).
        mockedCreateForItem.mockResolvedValue({
            item: conflictCopy("copy-3", "note"),
            title: "Note [Conflict 2026-01-01 00:00]",
        });

        await pullAndMerge();

        expect(await get(id)).toBeUndefined();
        expect(await get("copy-3")).toBeDefined();
        expect(mockedCreateForItem).toHaveBeenCalled();
        expect(mockedConflictAdd).toHaveBeenCalledWith(
            expect.objectContaining({ id: "copy-3", type: "note" }),
        );
    });

    it("pull deleted-log + local dirty FILE → conflict copy (not dropped)", async () => {
        const id = newId();
        await seedLocal({ id, type: "file", version: 1, dirty: true, chunk_set_id: "cs-d" });
        mockedPull.mockResolvedValue({
            items: [],
            deleted: [{ id, deleted_at: 1700000000 }],
            server_time: 100,
        } as never);
        mockedCreateForItem.mockResolvedValue({
            item: conflictCopy("copy-file-d", "file"),
            title: "file [Conflict]",
        });

        await pullAndMerge();

        expect(await get(id)).toBeUndefined();
        expect(await get("copy-file-d")).toBeDefined();
        expect(mockedCreateForItem).toHaveBeenCalled();
    });

    it("negative: clean (non-dirty) item purged → no conflict copy, no conflictStore entry", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: false });
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 2, purged_at: 1700000001 })],
            deleted: [],
            server_time: 100,
        } as never);

        await pullAndMerge();

        expect(await get(id)).toBeUndefined();
        expect(mockedCreateForItem).not.toHaveBeenCalled();
        expect(mockedConflictAdd).not.toHaveBeenCalled();
    });

    it("regression 1.0: purged_at + dirty FILE goes through createConflictCopyForItem (not re-key)", async () => {
        const id = newId();
        await seedLocal({
            id,
            type: "file",
            version: 1,
            dirty: true,
            chunk_set_id: "cs-1",
            chunk_count: 1,
            ciphertext_size: 10,
        } as Partial<LocalItem> & { id: string });
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, type: "file", version: 2, purged_at: 1700000001 })],
            deleted: [],
            server_time: 100,
        } as never);
        mockedCreateForItem.mockResolvedValue({
            item: conflictCopy("copy-f2", "file"),
            title: "file [Conflict 2026-01-01 00:00]",
        });

        await pullAndMerge();

        expect(mockedCreateForItem).toHaveBeenCalled(); // it picks by type → a file copy shares the chunk set
        expect(mockedCreateLocal).not.toHaveBeenCalled(); // it does NOT re-key (the bug before the fix)
        expect(mockedConflictAdd).toHaveBeenCalledWith(
            expect.objectContaining({ id: "copy-f2", type: "file" }),
        );
    });
});

describe("a push 409 tells the open editor which copy it made", () => {
    // The integration project runs without a DOM: a bare EventTarget stands in for window.
    function captureWindowEvents(): { events: CustomEvent[]; restore: () => void } {
        const events: CustomEvent[] = [];
        const win = new EventTarget();
        win.addEventListener("note:push-conflict", (e) => events.push(e as CustomEvent));
        (globalThis as unknown as { window: EventTarget }).window = win;
        return {
            events,
            restore: () => {
                delete (globalThis as unknown as { window?: EventTarget }).window;
            },
        };
    }

    function conflictOn(id: string, type: "note" | "folder" = "note") {
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [
                { id, current_item: { ...wireItem({ id, type, version: 5 }), user_id: "u" } },
            ],
            errors: [],
        } as never);
    }

    it("foreground push: one event naming the note, the copy and its title, with the server row in place", async () => {
        const { events, restore } = captureWindowEvents();
        try {
            const id = newId();
            await seedLocal({ id, version: 1, dirty: true, localRev: 3 });
            conflictOn(id);
            mockedCreateForItem.mockResolvedValue({
                item: conflictCopy("copy-125", "note"),
                title: "N [Conflict 2026-09-29 10:00]",
            });

            await pushItem({ id } as LocalItem);

            expect(events).toHaveLength(1);
            expect(events[0]?.detail).toEqual({
                noteId: id,
                copyId: "copy-125",
                copyTitle: "N [Conflict 2026-09-29 10:00]",
            });
            expect((await get(id))?.version).toBe(5);
            expect(await get("copy-125")).toBeDefined();
        } finally {
            restore();
        }
    });

    it("background drain: the same event", async () => {
        const { events, restore } = captureWindowEvents();
        try {
            const id = newId();
            await seedLocal({ id, version: 1, dirty: true, localRev: 3 });
            await enqueueMutation(id, "upsert");
            conflictOn(id);
            mockedCreateForItem.mockResolvedValue({
                item: conflictCopy("copy-drain", "note"),
                title: "N [Conflict]",
            });

            await pushPendingMutations();

            expect(events.map((e) => e.detail.copyId)).toEqual(["copy-drain"]);
        } finally {
            restore();
        }
    });

    it("no event when the versions are identical (no copy) or the item is not a note", async () => {
        const { events, restore } = captureWindowEvents();
        try {
            const same = newId();
            await seedLocal({ id: same, version: 1, dirty: true, localRev: 3 });
            conflictOn(same);
            mockedIsIdentical.mockResolvedValueOnce(true);
            await pushItem({ id: same } as LocalItem);

            const folder = newId();
            await seedLocal({ id: folder, type: "folder", version: 1, dirty: true, localRev: 3 });
            conflictOn(folder, "folder");
            mockedCreateForItem.mockResolvedValue({
                item: conflictCopy("copy-folder", "folder"),
                title: "F [Conflict]",
            });
            await pushItem({ id: folder } as LocalItem);

            expect(events).toHaveLength(0);
        } finally {
            restore();
        }
    });
});

describe("the pull's fail-closed branch when createConflictCopyForItem throws", () => {
    it("deletedEntries: the original stays, sync_error=pending_purge_conflict, and it is NOT deleted", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: true, localRev: 0 });
        mockedPull.mockResolvedValue({
            items: [],
            deleted: [{ id, deleted_at: 1700000001 }],
            server_time: 100,
        } as never);
        mockedCreateForItem.mockRejectedValue(new Error("vault locked"));

        await pullAndMerge();

        const local = await get(id);
        expect(local).toBeDefined();
        expect(local?.dirty).toBe(true);
        expect(local?.sync_error).toBe("pending_purge_conflict");
        expect(mockedConflictAdd).not.toHaveBeenCalled();
    });

    it("purged_at in items[]: the original stays, sync_error=pending_purge_conflict, and it is NOT deleted", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: true, localRev: 0 });
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 2, purged_at: 1700000001 })],
            deleted: [],
            server_time: 100,
        } as never);
        mockedCreateForItem.mockRejectedValue(new Error("vault locked"));

        await pullAndMerge();

        const local = await get(id);
        expect(local).toBeDefined();
        expect(local?.dirty).toBe(true);
        expect(local?.sync_error).toBe("pending_purge_conflict");
        expect(mockedConflictAdd).not.toHaveBeenCalled();
    });
});

describe("orphan file-ref cleanup on pull", () => {
    it("calls cleanupOrphanedFileRefs for deleted and purged file tombstones", async () => {
        // Prepare local files
        await seedLocal({ id: "f-deleted", type: "file", chunk_set_id: "c1" });
        await seedLocal({ id: "f-purged", type: "file", chunk_set_id: "c2" });
        // Prepare a non-file
        await seedLocal({ id: "n-deleted", type: "note" });

        mockedPull.mockResolvedValueOnce({
            items: [wireItem({ id: "f-purged", purged_at: 10 }) as never],
            deleted: [
                { id: "f-deleted", version: 2 },
                { id: "n-deleted", version: 2 },
            ],
            server_time: 100,
        } as never);

        await pullAndMerge();

        const mockedCleanup = vi.mocked(fileBridge.cleanupOrphanedFileRefs);
        expect(mockedCleanup).toHaveBeenCalledTimes(1);

        // It has to send f-deleted (from deletedEntries) and f-purged (from the items carrying purged_at)
        const callArgs = mockedCleanup.mock.calls[0]?.[0];
        expect(callArgs).toContain("f-deleted");
        expect(callArgs).toContain("f-purged");
        expect(callArgs).not.toContain("n-deleted"); // Not a file
    });
});

describe("pull does not resurrect pending purge", () => {
    it("local purged_at + clean → server-live newer version does NOT overwrite", async () => {
        const id = newId();
        // Permanently deleted locally (permanentDeleteItem sets purged_at), and clean.
        await seedLocal({ id, version: 1, dirty: false, purged_at: 1700000000 });
        // The server still has a live, newer version (the delete has not reached it yet).
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 5, purged_at: null })],
            deleted: [],
            server_time: 100,
        } as never);

        await pullAndMerge();

        const row = await get(id);
        expect(row).toBeDefined(); // the tombstone stays
        expect(row?.purged_at).toBe(1700000000); // NOT resurrected
        expect(row?.version).toBe(1); // the server state was not applied
    });

    it("server purge tombstone still cleans up local purged row", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: false, purged_at: 1700000000 });
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 5, purged_at: 1700000002 })],
            deleted: [],
            server_time: 100,
        } as never);

        await pullAndMerge();

        expect(await get(id)).toBeUndefined(); // cleared once the server confirms the purge
    });
});

describe("background push preserves concurrent edits", () => {
    it("does not clear dirty when item is edited during background push", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: true, localRev: 5 });
        await enqueueMutation(id, "upsert");

        // Simulate a user edit WHILE the push awaits the server's answer: localRev grows, dirty stays true.
        mockedPush.mockImplementation(async () => {
            const db = await getDB();
            const item = await db.get("items", id);
            if (item) {
                item.localRev = 6;
                item.dirty = true;
                await db.put("items", item);
            }
            return {
                succeeded: [{ id, version: 2, updated_at: 2, created_at: 1 }],
                conflicts: [],
                errors: [],
            } as never;
        });

        await pushPendingMutations();

        const row = await get(id);
        expect(row?.dirty).toBe(true); // the new changes have to survive for the next push
        expect(row?.version).toBe(2); // the server version was taken over
        // The dirty row has to stay in the mutation queue (no orphan dirty with nothing to push).
        expect(await getPendingMutationCount()).toBe(1);
        const db = await getDB();
        expect(await db.get("mutation-queue", id)).toBeDefined();
    });
});

describe("pushDeletes chunking", () => {
    it("sends >1000 delete_ids in multiple sequential batch calls", async () => {
        const ids = Array.from({ length: FILE_LIMITS.MAX_BATCH_OPS + 500 }, (_, i) => `del-${i}`);
        for (const id of ids) {
            await seedLocal({ id, version: 1, dirty: false, purged_at: 1700000000 });
        }

        mockedPush.mockResolvedValue({ succeeded: [], conflicts: [], errors: [] } as never);

        await pushDeletes(ids);

        expect(mockedPush).toHaveBeenCalledTimes(2);
        expect(mockedPush.mock.calls[0]?.[1]).toHaveLength(FILE_LIMITS.MAX_BATCH_OPS);
        expect(mockedPush.mock.calls[1]?.[1]).toHaveLength(500);
        for (const id of ids) {
            expect(await get(id)).toBeUndefined();
        }
    });
});

describe("drain delete mutation is version-aware", () => {
    it("sends {id, version} from local tombstone so stale purge can't destroy bumped server item", async () => {
        const id = newId();
        // A local tombstone (permanentDeleteItem/hardDelete left purged_at) with a known version.
        await seedLocal({ id, version: 3, dirty: false, purged_at: 1700000000 });
        await enqueueMutation(id, "delete");

        mockedPush.mockResolvedValue({ succeeded: [], conflicts: [], errors: [] } as never);

        await pushPendingMutations();

        // The server receives the version → it can refuse the purge if it moved meanwhile (the
        // stale-delete guard).
        expect(mockedPush).toHaveBeenCalledWith([], [{ id, version: 3 }]);
        // The tombstone is cleared locally after a successful acknowledgement.
        expect(await get(id)).toBeUndefined();
    });
});

describe("conflict copy failure surfaces error", () => {
    it("createConflictCopyForItem throws → markSyncError called, local stays dirty (no silent loop)", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: true, localRev: 0 });
        await enqueueMutation(id, "upsert");
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [{ id, current_item: { ...wireItem({ id, version: 9 }), user_id: "u" } }],
            errors: [],
        } as never);
        // The crypto worker is unavailable → no conflict copy can be made.
        mockedCreateForItem.mockRejectedValue(new Error("crypto worker unavailable"));

        await pushItem({ id } as LocalItem);

        expect(syncStore.markSyncError).toHaveBeenCalled(); // the error is surfaced, not silent
        const original = await get(id);
        expect(original?.dirty).toBe(true); // the local changes are kept for a retry
        expect(original?.version).toBe(1); // NOT overwritten by the server's
        // A requeue — it must not be left dirty with no mutation-queue entry.
        expect(await getPendingMutationCount()).toBe(1);
        const db = await getDB();
        expect(await db.get("mutation-queue", id)).toBeDefined();
    });
});

describe("pending mutation count", () => {
    it("getPendingMutationCount grows on enqueueMutation, drops to 0 after a successful drain", async () => {
        expect(await getPendingMutationCount()).toBe(0);

        const id = newId();
        await seedLocal({ id, version: 1, dirty: true, localRev: 0 });
        await enqueueMutation(id, "upsert");

        expect(await getPendingMutationCount()).toBe(1);

        // The drain: the server accepts the item → the mutation is removed from the queue.
        mockedPush.mockResolvedValue({
            succeeded: [{ id, version: 2, updated_at: 2, created_at: 1 }],
            conflicts: [],
            errors: [],
        } as never);

        await pushPendingMutations();

        expect(await getPendingMutationCount()).toBe(0);
    });

    it("re-enqueues (count stays 1) when the server rejects the item during drain", async () => {
        const id = newId();
        await seedLocal({ id, type: "file", version: 1, dirty: true, localRev: 0 });
        await enqueueMutation(id, "upsert");
        expect(await getPendingMutationCount()).toBe(1);

        // The server refuses (the chunk set is not committed, say) → the mutation stays in the queue for a backoff.
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [],
            errors: [{ id, error: "rejected by server" }],
        } as never);

        await pushPendingMutations();

        expect(await getPendingMutationCount()).toBe(1);
    });
});

describe("conflict_of detection on the pull path (the cross-device marker)", () => {
    it("a new server item carrying conflict_of in the payload → the column is mirrored onto the row and conflictStore.add is called", async () => {
        const id = newId();
        vi.mocked(decryptItemPayload).mockResolvedValueOnce({
            title: "Note [Conflict 2026-06-26 10:00]",
            conflict_of: "orig-42",
        } as never);

        mockedPull.mockResolvedValue({
            items: [wireItem({ id, encrypted_payload: "cp", payload_nonce: "np" })],
            deleted: [],
            server_time: 200,
        } as never);

        await pullAndMerge();

        const db = await getDB();
        const stored = await db.get("items", id);
        expect(stored?.conflict_of).toBe("orig-42"); // mirrored onto the plaintext column
        expect(mockedConflictAdd).toHaveBeenCalledTimes(1);
        const addArg = mockedConflictAdd.mock.calls[0]?.[0];
        expect(addArg?.id).toBe(id);
    });

    it("a new server item WITHOUT conflict_of → conflictStore.add is NOT called", async () => {
        const id = newId();
        vi.mocked(decryptItemPayload).mockResolvedValueOnce({ title: "Normal Note" } as never);

        mockedPull.mockResolvedValue({
            items: [wireItem({ id, encrypted_payload: "x", payload_nonce: "n" })],
            deleted: [],
            server_time: 201,
        } as never);

        await pullAndMerge();

        const db = await getDB();
        expect((await db.get("items", id))?.conflict_of).toBeUndefined();
        expect(mockedConflictAdd).not.toHaveBeenCalled();
    });

    it("the decryption fails (a locked vault) → the item is still saved, conflict_of is undefined, and nothing throws", async () => {
        const id = newId();
        vi.mocked(decryptItemPayload).mockRejectedValueOnce(new Error("vault locked"));

        mockedPull.mockResolvedValue({
            items: [wireItem({ id, encrypted_payload: "x", payload_nonce: "n" })],
            deleted: [],
            server_time: 202,
        } as never);

        await expect(pullAndMerge()).resolves.not.toThrow();

        const db = await getDB();
        const stored = await db.get("items", id);
        expect(stored).toBeDefined(); // the item is stored even with no marker
        expect(stored?.conflict_of).toBeUndefined();
        expect(mockedConflictAdd).not.toHaveBeenCalled();
    });
});

describe("migrateLegacyItems", () => {
    it("migrates items with epoch-style version numbers", async () => {
        const id = newId();
        await seedLocal({ id, version: 1_700_000_000_123, dirty: false });

        await migrateLegacyItems();

        const stored = await get(id);
        expect(stored?.version).toBe(1);
        expect(stored?.dirty).toBe(true);
        expect(await getPendingMutationCount()).toBe(1);
    });

    it("migrates items missing the dirty flag", async () => {
        const id = newId();
        const db = await getDB();
        await db.put("items", {
            id,
            type: "note",
            parent_id: null,
            encrypted_payload: null,
            payload_nonce: null,
            encrypted_item_key: null,
            item_key_nonce: null,
            version: 2,
            sort_order: "m",
            localRev: 0,
        } as LocalItem);

        await migrateLegacyItems();

        const stored = await get(id);
        expect(stored?.dirty).toBe(true);
        expect(stored?.localRev).toBe(0);
        expect(await getPendingMutationCount()).toBe(1);
    });

    it("leaves modern synced items untouched", async () => {
        const id = newId();
        await seedLocal({ id, version: 3, dirty: false });

        await migrateLegacyItems();

        const stored = await get(id);
        expect(stored?.version).toBe(3);
        expect(stored?.dirty).toBe(false);
        expect(await getPendingMutationCount()).toBe(0);
    });
});

describe("user-switch guard", () => {
    it("push operations are suppressed while pendingClearForUser is true", async () => {
        const mem: Record<string, string> = {};
        const oldLs = globalThis.localStorage;
        globalThis.localStorage = {
            getItem: (k: string) => mem[k] ?? null,
            setItem: (k: string, v: string) => {
                mem[k] = String(v);
            },
            removeItem: (k: string) => {
                delete mem[k];
            },
            clear: () => {
                for (const k in mem) delete mem[k];
            },
            length: 0,
            key: () => null,
        };

        const { savePersisted, STORAGE_KEYS, rawStringSerde } = await import(
            "$lib/core/utils/persisted"
        );
        savePersisted(STORAGE_KEYS.pendingClearForUser, "true", rawStringSerde);

        const pushBatchMock = vi.mocked(pushBatch);
        pushBatchMock.mockClear();

        const id = newId();
        const item = { id, type: "note", version: 1 } as LocalItem;

        await pushItem(item);
        await pushDeletes([id]);
        await pushPendingMutations();

        expect(pushBatchMock).not.toHaveBeenCalled();

        savePersisted(STORAGE_KEYS.pendingClearForUser, "", rawStringSerde);
        globalThis.localStorage = oldLs;
    });
});

describe("byte chunking and error classification", () => {
    it("chunks batch by byte size limit", async () => {
        const pushBatchMock = vi.mocked(pushBatch);
        pushBatchMock.mockClear();
        pushBatchMock.mockResolvedValue({ succeeded: [], conflicts: [] });

        // Create 3 items, each with a 5 MB payload (~6.6 MB base64).
        // SYNC_LIMITS.MAX_BATCH_BYTES is 8 MB, so two items cannot share a batch.
        const db = await getDB();
        const payload5MB = "A".repeat(5 * 1024 * 1024);

        for (let i = 1; i <= 3; i++) {
            const id = `item-byte-chunk-${i}`;
            await db.put("items", {
                id,
                type: "note",
                parent_id: null,
                encrypted_payload: payload5MB,
                payload_nonce: "A".repeat(32),
                encrypted_item_key: "C".repeat(64),
                item_key_nonce: "B".repeat(32),
                version: 1,
                sort_order: "m",
                localRev: 0,
                dirty: true,
            } as LocalItem);
            await enqueueMutation(id, "upsert");
        }

        await pushPendingMutations();

        expect(pushBatchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("surfaces markSyncError on permanent 413 error and drops mutation after retries", async () => {
        const { ApiError } = await import("$lib/core/api");
        const pushBatchMock = vi.mocked(pushBatch);
        pushBatchMock.mockClear();
        pushBatchMock.mockRejectedValue(new ApiError("Payload Too Large", 413));

        const db = await getDB();
        const id = "item-poison-413";
        await db.put("items", {
            id,
            type: "note",
            parent_id: null,
            encrypted_payload: "A".repeat(100),
            payload_nonce: "A".repeat(32),
            encrypted_item_key: "C".repeat(64),
            item_key_nonce: "B".repeat(32),
            version: 1,
            sort_order: "m",
            localRev: 0,
            dirty: true,
        } as LocalItem);
        await enqueueMutation(id, "upsert");

        // Three push attempts (attempted_at is reset to 0 so the test does not wait out the backoff)
        await pushPendingMutations();
        const mut1 = await db.get("mutation-queue", id);
        if (mut1) {
            mut1.attempted_at = 0;
            await db.put("mutation-queue", mut1);
        }

        await pushPendingMutations();
        const mut2 = await db.get("mutation-queue", id);
        if (mut2) {
            mut2.attempted_at = 0;
            await db.put("mutation-queue", mut2);
        }

        await pushPendingMutations();

        expect(syncStore.markSyncError).toHaveBeenCalled();
        expect(await getPendingMutationCount()).toBe(0);
    });
});

describe("pushPendingMutations backoff vs force (Sync now)", () => {
    async function seedBackoffMutation(id: string) {
        await seedLocal({
            id,
            type: "file",
            dirty: true,
            deleted_at: 1_700_000_000,
            encrypted_payload: "A".repeat(100),
            payload_nonce: "A".repeat(32),
            encrypted_item_key: "C".repeat(64),
            item_key_nonce: "B".repeat(32),
        });
        const db = await getDB();
        await db.put("mutation-queue", {
            id,
            type: "upsert" as const,
            attempted_at: Date.now(),
            attempt_count: 21,
        });
    }

    it("skips a mutation still inside the backoff window", async () => {
        const id = newId();
        await seedBackoffMutation(id);
        mockedPush.mockResolvedValue({ succeeded: [], conflicts: [], errors: [] } as never);

        await pushPendingMutations();

        expect(mockedPush).not.toHaveBeenCalled();
        expect(await getPendingMutationCount()).toBe(1);
    });

    it("force:true pushes a mutation even while backoff is pending", async () => {
        const id = newId();
        await seedBackoffMutation(id);
        mockedPush.mockResolvedValue({
            succeeded: [{ id, version: 2, updated_at: 2, created_at: 1 }],
            conflicts: [],
            errors: [],
        } as never);

        await pushPendingMutations({ force: true });

        expect(mockedPush).toHaveBeenCalled();
        expect(await getPendingMutationCount()).toBe(0);
    });
});

describe("reconcile & purge queueing", () => {
    it("reconciles dirty items missing from mutation queue", async () => {
        const { reconcilePendingMutations } = await import("./engine");
        const db = await getDB();
        const id = "item-dirty-no-queue";
        await db.put("items", {
            id,
            type: "note",
            parent_id: null,
            encrypted_payload: "A".repeat(100),
            payload_nonce: "A".repeat(32),
            encrypted_item_key: "C".repeat(64),
            item_key_nonce: "B".repeat(32),
            version: 1,
            sort_order: "m",
            localRev: 0,
            dirty: true,
        } as LocalItem);

        // There is no row in the mutation queue
        await db.delete("mutation-queue", id);

        const count = await reconcilePendingMutations();
        expect(count).toBeGreaterThanOrEqual(1);

        const mut = await db.get("mutation-queue", id);
        expect(mut).toBeDefined();
        expect(mut?.type).toBe("upsert");
    });

    it("permanentDeleteItem enqueues delete mutation in queue before network", async () => {
        const { ItemService } = await import("../services/item-service");
        const db = await getDB();
        const id = "item-purge-enqueued";
        await db.put("items", {
            id,
            type: "note",
            parent_id: null,
            deleted_at: Math.floor(Date.now() / 1000),
            version: 1,
            sort_order: "m",
        } as LocalItem);

        await ItemService.permanentDeleteItem(id);

        const mut = await db.get("mutation-queue", id);
        expect(mut).toBeDefined();
        expect(mut?.type).toBe("delete");
    });

    it("removes mutation from queue when server responds with Item is permanently deleted", async () => {
        const pushBatchMock = vi.mocked(pushBatch);
        pushBatchMock.mockClear();
        pushBatchMock.mockResolvedValueOnce({
            succeeded: [],
            conflicts: [],
            errors: [{ id: "item-already-purged", error: "Item is permanently deleted" }],
        });

        const db = await getDB();
        const id = "item-already-purged";
        await db.put("items", {
            id,
            type: "note",
            parent_id: null,
            purged_at: Math.floor(Date.now() / 1000),
            version: 1,
            sort_order: "m",
        } as LocalItem);
        await enqueueMutation(id, "delete");

        await pushPendingMutations();

        const mut = await db.get("mutation-queue", id);
        expect(mut).toBeUndefined();
    });
});

describe("restore: parent/child across a chunk boundary", () => {
    /**
     * Emulates /items/batch: within a batch the server sorts topologically (topoSortByParent), so a
     * parent in the SAME batch is fine. A parent that is neither in the batch nor already on the
     * server → "Parent not found".
     */
    function mockServerWithParentCheck() {
        const serverIds = new Set<string>();
        vi.mocked(pushBatch).mockImplementation(async (upsert: any[]) => {
            const inBatch = new Set(upsert.map((i) => i.id));
            const succeeded: any[] = [];
            const errors: any[] = [];
            for (const it of upsert) {
                if (it.parent_id && !serverIds.has(it.parent_id) && !inBatch.has(it.parent_id)) {
                    errors.push({ id: it.id, error: "Parent not found" });
                    continue;
                }
                serverIds.add(it.id);
                succeeded.push({ id: it.id, version: 2, updated_at: 10, created_at: 1 });
            }
            return { succeeded, conflicts: [], errors } as never;
        });
        return serverIds;
    }

    async function seedDirty(id: string, over: Partial<LocalItem>, payload: string) {
        const db = await getDB();
        await db.put("items", {
            id,
            type: "note",
            parent_id: null,
            encrypted_payload: payload,
            payload_nonce: "A".repeat(32),
            encrypted_item_key: "C".repeat(64),
            item_key_nonce: "B".repeat(32),
            version: 1,
            sort_order: "m",
            localRev: 0,
            dirty: true,
            ...over,
        } as LocalItem);
        await enqueueMutation(id, "upsert");
    }

    it("a child stays in its folder when the parent falls into a later chunk", async () => {
        vi.mocked(pushBatch).mockClear();
        mockServerWithParentCheck();

        // The queue drains by key (UUIDv7) — the "aa-" child goes BEFORE the "zz-" parent,
        // and the 5 MB payloads split them across two chunks (MAX_BATCH_BYTES = 8 MiB).
        const big = "A".repeat(5 * 1024 * 1024);
        await seedDirty("aa-child-note", { parent_id: "zz-parent-folder" }, big);
        await seedDirty("zz-parent-folder", { type: "folder" }, big);

        await pushPendingMutations();

        expect(await get("aa-child-note")).toMatchObject({ parent_id: "zz-parent-folder" });
    });

    it("a transient 'Parent not found' does not move the item to the root while the parent still awaits its push", async () => {
        vi.mocked(pushBatch).mockResolvedValue({
            succeeded: [],
            conflicts: [],
            errors: [{ id: "child-pending", error: "Parent not found" }],
        } as never);

        await seedDirty("child-pending", { parent_id: "folder-pending" }, "A".repeat(100));
        await seedDirty("folder-pending", { type: "folder" }, "A".repeat(100));

        await pushPendingMutations();

        // The parent exists locally → the hierarchy is preserved and the backoff gets its chance.
        expect(await get("child-pending")).toMatchObject({ parent_id: "folder-pending" });
        expect(await (await getDB()).get("mutation-queue", "child-pending")).toBeDefined();
    });

    it("'Parent not found' for a parent that does not exist locally either → the item goes to the root", async () => {
        vi.mocked(pushBatch).mockResolvedValue({
            succeeded: [],
            conflicts: [],
            errors: [{ id: "child-orphan", error: "Parent not found" }],
        } as never);

        await seedDirty("child-orphan", { parent_id: "folder-gone" }, "A".repeat(100));

        await pushPendingMutations();

        expect(await get("child-orphan")).toMatchObject({ parent_id: null });
    });

    it("'Parent not found' does drop the item to the root once the attempt budget is spent", async () => {
        vi.mocked(pushBatch).mockResolvedValue({
            succeeded: [],
            conflicts: [],
            errors: [{ id: "child-stuck", error: "Parent not found" }],
        } as never);

        const db = await getDB();
        await seedDirty("child-stuck", { parent_id: "folder-stuck" }, "A".repeat(100));
        await seedDirty("folder-stuck", { type: "folder" }, "A".repeat(100));
        // The parent has not appeared on the server even after 3 drain cycles → a genuine desync.
        await db.put("mutation-queue", {
            id: "child-stuck",
            type: "upsert",
            attempted_at: 0,
            attempt_count: 3,
        });

        await pushPendingMutations();

        expect(await get("child-stuck")).toMatchObject({ parent_id: null });
    });

    it("'Parent is not a folder' self-heals at once — a type error, where a retry does not help", async () => {
        vi.mocked(pushBatch).mockResolvedValue({
            succeeded: [],
            conflicts: [],
            errors: [{ id: "child-typed", error: "Parent is not a folder" }],
        } as never);

        await seedDirty("parent-note", {}, "A".repeat(100));
        await seedDirty("child-typed", { parent_id: "parent-note" }, "A".repeat(100));

        await pushPendingMutations();

        expect(await get("child-typed")).toMatchObject({ parent_id: null });
    });
});

describe("an upsert refused because the server purged the row", () => {
    async function seedLiveDirty(id: string, over: Partial<LocalItem> = {}) {
        const db = await getDB();
        await db.put("items", {
            id,
            type: "note",
            parent_id: null,
            encrypted_payload: "enc",
            payload_nonce: "n",
            encrypted_item_key: "k",
            item_key_nonce: "kn",
            version: 1,
            sort_order: "m",
            localRev: 0,
            dirty: true,
            ...over,
        } as LocalItem);
        await enqueueMutation(id, "upsert");
    }

    function rejectPurged(id: string) {
        vi.mocked(pushBatch).mockResolvedValue({
            succeeded: [],
            conflicts: [],
            errors: [{ id, error: "Item is permanently deleted" }],
        } as never);
    }

    it("does NOT delete the local content — it marks it for a purge conflict and removes it from the queue", async () => {
        rejectPurged("restored-zombie");
        await seedLiveDirty("restored-zombie");

        await pushPendingMutations();

        // The content — a note restored from a backup, say — has to survive.
        const local = await get("restored-zombie");
        expect(local).toBeDefined();
        expect(local?.sync_error).toBe("pending_purge_conflict");
        // The loop is broken: the mutation is no longer in the queue.
        expect(await (await getDB()).get("mutation-queue", "restored-zombie")).toBeUndefined();
    });

    it("the next drain resurrects it as a new item and removes the original", async () => {
        rejectPurged("zombie-2");
        await seedLiveDirty("zombie-2");
        await pushPendingMutations();

        mockedCreateForItem.mockResolvedValue({
            item: conflictCopy("zombie-2-copy", "note"),
            title: "Note [Conflict 2026-08-27 10:00]",
        });
        vi.mocked(pushBatch).mockResolvedValue({
            succeeded: [],
            conflicts: [],
            errors: [],
        } as never);

        // reconcilePendingMutations → retryPendingPurgeConflicts
        await pushPendingMutations();

        expect(await get("zombie-2-copy")).toBeDefined();
        expect(await get("zombie-2")).toBeUndefined();
        expect(mockedConflictAdd).toHaveBeenCalledWith(
            expect.objectContaining({ id: "zombie-2-copy" }),
        );
    });

    it("an item already tombstoned locally simply drops out of the queue, with no resurrection", async () => {
        rejectPurged("locally-purged");
        await seedLiveDirty("locally-purged", { purged_at: 1_700_000_000 });
        mockedCreateForItem.mockClear();

        await pushPendingMutations();

        expect(await (await getDB()).get("mutation-queue", "locally-purged")).toBeUndefined();
        expect(mockedCreateForItem).not.toHaveBeenCalled();
    });
});

describe("pullAndMerge — paginated pull", () => {
    it("applies pages as they arrive and writes watermark only after the last page", async () => {
        await setWatermark(50);
        const a = newId();
        const b = newId();
        mockedPage.mockReset();
        mockedPage
            .mockResolvedValueOnce({
                items: [wireItem({ id: a, version: 2 })],
                deleted: [],
                server_time: 999,
                next_cursor: "cursor-1",
            } as never)
            .mockRejectedValueOnce(new TypeError("Failed to fetch"));

        await pullAndMerge();

        expect(await get(a)).toBeDefined();
        expect(await getWatermark()).toBe(50);

        mockedPage.mockReset();
        mockedPage
            .mockResolvedValueOnce({
                items: [wireItem({ id: a, version: 2 })],
                deleted: [],
                server_time: 999,
                next_cursor: "cursor-1",
            } as never)
            .mockResolvedValueOnce({
                items: [wireItem({ id: b, version: 2 })],
                deleted: [],
                server_time: 999,
                next_cursor: null,
            } as never);

        await pullAndMerge();

        expect(await get(a)).toBeDefined();
        expect(await get(b)).toBeDefined();
        expect(await getWatermark()).toBe(999);
    });

    it("retries 429 on the third page from the same cursor and finishes", async () => {
        const ids = [newId(), newId(), newId()];
        mockedPage.mockReset();
        mockedPage
            .mockResolvedValueOnce({
                items: [wireItem({ id: ids[0]!, version: 2 })],
                deleted: [],
                server_time: 200,
                next_cursor: "c1",
            } as never)
            .mockResolvedValueOnce({
                items: [wireItem({ id: ids[1]!, version: 2 })],
                deleted: [],
                server_time: 200,
                next_cursor: "c2",
            } as never)
            .mockRejectedValueOnce(new ApiError("rate limited", 429))
            .mockResolvedValueOnce({
                items: [wireItem({ id: ids[2]!, version: 2 })],
                deleted: [],
                server_time: 200,
                next_cursor: null,
            } as never);

        await pullAndMerge();

        expect(mockedPage.mock.calls.length).toBe(4);
        expect(mockedPage.mock.calls[2]?.[0]).toEqual(mockedPage.mock.calls[3]?.[0]);
        expect(mockedPage.mock.calls[3]?.[0]).toMatchObject({ cursor: "c2" });
        for (const id of ids) expect(await get(id)).toBeDefined();
        expect(await getWatermark()).toBe(200);
    });

    it("pendingClear wipe: a failed second page does not empty the vault", async () => {
        const mem: Record<string, string> = {};
        const oldLs = globalThis.localStorage;
        globalThis.localStorage = {
            getItem: (k: string) => mem[k] ?? null,
            setItem: (k: string, v: string) => {
                mem[k] = String(v);
            },
            removeItem: (k: string) => {
                delete mem[k];
            },
            clear: () => {
                for (const k in mem) delete mem[k];
            },
            length: 0,
            key: () => null,
        };

        const { savePersisted, STORAGE_KEYS, rawStringSerde, loadPersisted } = await import(
            "$lib/core/utils/persisted"
        );
        const oldId = newId();
        await seedLocal({ id: oldId, version: 1 });
        savePersisted(STORAGE_KEYS.pendingClearForUser, "true", rawStringSerde);

        const freshId = newId();
        mockedPage.mockReset();
        mockedPage
            .mockResolvedValueOnce({
                items: [wireItem({ id: freshId, version: 1 })],
                deleted: [],
                server_time: 300,
                next_cursor: "more",
            } as never)
            .mockRejectedValueOnce(new TypeError("Failed to fetch"));

        await pullAndMerge();

        expect(await get(oldId)).toBeDefined();
        expect(await get(freshId)).toBeDefined();
        expect(loadPersisted(STORAGE_KEYS.pendingClearForUser, "false", rawStringSerde)).toBe(
            "true",
        );
        expect(await getWatermark()).toBe(0);

        mockedPage.mockReset();
        mockedPage
            .mockResolvedValueOnce({
                items: [wireItem({ id: freshId, version: 1 })],
                deleted: [],
                server_time: 300,
                next_cursor: "more",
            } as never)
            .mockResolvedValueOnce({
                items: [],
                deleted: [],
                server_time: 300,
                next_cursor: null,
            } as never);

        await pullAndMerge();

        expect(await get(oldId)).toBeUndefined();
        expect(await get(freshId)).toBeDefined();
        expect(loadPersisted(STORAGE_KEYS.pendingClearForUser, "false", rawStringSerde)).toBe(
            "false",
        );
        expect(await getWatermark()).toBe(300);

        globalThis.localStorage = oldLs;
    });

    it("pendingClear wipe: a dirty item created during a multi-page pull is not swept", async () => {
        const mem: Record<string, string> = {};
        const oldLs = globalThis.localStorage;
        globalThis.localStorage = {
            getItem: (k: string) => mem[k] ?? null,
            setItem: (k: string, v: string) => {
                mem[k] = String(v);
            },
            removeItem: (k: string) => {
                delete mem[k];
            },
            clear: () => {
                for (const k in mem) delete mem[k];
            },
            length: 0,
            key: () => null,
        };

        const { savePersisted, STORAGE_KEYS, rawStringSerde } = await import(
            "$lib/core/utils/persisted"
        );
        const leftoverId = newId();
        await seedLocal({ id: leftoverId, version: 1, dirty: true });
        const db = await getDB();
        await db.put("mutation-queue", {
            id: leftoverId,
            type: "upsert",
            attempted_at: 0,
            attempt_count: 0,
        });
        savePersisted(STORAGE_KEYS.pendingClearForUser, "true", rawStringSerde);

        const serverId = newId();
        const createdDuringPullId = newId();
        mockedPage.mockReset();
        mockedPage
            .mockResolvedValueOnce({
                items: [wireItem({ id: serverId, version: 1 })],
                deleted: [],
                server_time: 300,
                next_cursor: "more",
            } as never)
            .mockImplementationOnce(async () => {
                await seedLocal({
                    id: createdDuringPullId,
                    version: 1,
                    dirty: true,
                    localRev: 1,
                });
                await db.put("mutation-queue", {
                    id: createdDuringPullId,
                    type: "upsert",
                    attempted_at: 0,
                    attempt_count: 0,
                });
                return {
                    items: [],
                    deleted: [],
                    server_time: 300,
                    next_cursor: null,
                };
            });

        await pullAndMerge();

        expect(await get(serverId)).toBeDefined();
        expect(await get(leftoverId)).toBeUndefined();
        expect(await get(createdDuringPullId)).toBeDefined();
        expect((await get(createdDuringPullId))?.dirty).toBe(true);
        expect(await db.get("mutation-queue", createdDuringPullId)).toBeDefined();
        expect(await db.get("mutation-queue", leftoverId)).toBeUndefined();

        globalThis.localStorage = oldLs;
    });
});

describe("pullAndMerge — replaceLocal wipes local-only state", () => {
    it("mark-and-sweeps items absent from the full pull and clears mutation-queue/upload caches", async () => {
        const db = await getDB();

        // A local item the server will not return (a remnant of a previous vault state, say) — it has
        // to disappear after phase 5, exactly as the pendingClear mark-and-sweep does.
        const staleId = newId();
        await seedLocal({ id: staleId, version: 1 });

        await db.put("mutation-queue", {
            id: staleId,
            type: "upsert",
            attempted_at: 0,
            attempt_count: 0,
        });
        await db.put("pending-uploads", {
            local_id: "pending-1",
        } as never);
        await db.put("upload-chunks", {
            key: "pending-1:0",
            pendingLocalId: "pending-1",
            index: 0,
            ciphertext: new Uint8Array([1]),
            nonce: "n",
            hash: "h",
            size: 1,
            storedAt: 0,
        });
        await db.put("file-chunks", {
            key: "chunkset-1:0",
            chunkSetId: "chunkset-1",
            index: 0,
            ciphertext: new Uint8Array([1]),
            nonce: new Uint8Array([2]),
            storedAt: 0,
        });

        const freshId = newId();
        mockedPage.mockReset();
        mockedPage.mockResolvedValueOnce({
            items: [wireItem({ id: freshId, version: 1 })],
            deleted: [],
            server_time: 500,
            next_cursor: null,
        } as never);

        await pullAndMerge({ replaceLocal: true });

        expect(await get(staleId)).toBeUndefined();
        expect(await get(freshId)).toBeDefined();
        expect(await db.get("mutation-queue", staleId)).toBeUndefined();
        expect(await db.count("pending-uploads")).toBe(0);
        expect(await db.count("upload-chunks")).toBe(0);
        expect(await db.count("file-chunks")).toBe(0);
        expect(await getWatermark()).toBe(500);
    });
});

describe("pullAndMerge — UI keys", () => {
    it("the isPendingClear wipe clears cn_recent_notes, the pins and f_* (the same function as phase 5)", async () => {
        const mem: Record<string, string> = {
            theme: "dark",
            cn_recent_notes: '["abc"]',
            "zknotes:pinned-items": '["p1"]',
            f_folder1: "1",
        };
        const oldLs = globalThis.localStorage;
        globalThis.localStorage = {
            getItem: (k: string) => mem[k] ?? null,
            setItem: (k: string, v: string) => {
                mem[k] = String(v);
            },
            removeItem: (k: string) => {
                delete mem[k];
            },
            clear: () => {
                for (const k in mem) delete mem[k];
            },
            get length() {
                return Object.keys(mem).length;
            },
            key: (i: number) => Object.keys(mem)[i] ?? null,
        };

        const { savePersisted, STORAGE_KEYS, rawStringSerde } = await import(
            "$lib/core/utils/persisted"
        );
        savePersisted(STORAGE_KEYS.pendingClearForUser, "true", rawStringSerde);

        const freshId = newId();
        mockedPage.mockReset();
        mockedPage.mockResolvedValueOnce({
            items: [wireItem({ id: freshId, version: 1 })],
            deleted: [],
            server_time: 400,
            next_cursor: null,
        } as never);

        await pullAndMerge();

        expect(mem.theme).toBe("dark");
        expect(mem.cn_recent_notes).toBeUndefined();
        expect(mem["zknotes:pinned-items"]).toBeUndefined();
        expect(mem.f_folder1).toBeUndefined();

        globalThis.localStorage = oldLs;
    });
});

describe("a refused foreground purge leaves no stale delete mutation (version-aware delete)", () => {
    it("pushDeletes conflict → the server row is restored, the queue is empty, the next drain sends nothing", async () => {
        const id = newId();
        // permanentDeleteItem: a local tombstone (v2) plus the queued delete BEFORE the network.
        await seedLocal({ id, version: 2, purged_at: 1700000000 });
        await enqueueMutation(id, "delete");
        // The server refused: another device restored the note meanwhile (v3, live).
        mockedPush.mockResolvedValueOnce({
            succeeded: [],
            conflicts: [{ id, current_item: { ...wireItem({ id, version: 3 }), user_id: "u" } }],
            errors: [],
        } as never);

        await pushDeletes([id]);

        const restored = await get(id);
        expect(restored?.version).toBe(3);
        expect(restored?.purged_at ?? null).toBeNull();
        expect(await getPendingMutationCount()).toBe(0);

        // The next drain must NOT purge it with the now-matching version.
        mockedPush.mockClear();
        mockedPush.mockResolvedValue({ succeeded: [], conflicts: [], errors: [] } as never);
        await pushPendingMutations({ force: true });
        expect(mockedPush).not.toHaveBeenCalled();
        expect((await get(id))?.version).toBe(3);
    });

    it("drain: a delete mutation whose local row is live is dropped, never sent", async () => {
        const id = newId();
        await seedLocal({ id, version: 3, dirty: false }); // a live row — no purged_at
        await enqueueMutation(id, "delete");
        mockedPush.mockResolvedValue({ succeeded: [], conflicts: [], errors: [] } as never);

        await pushPendingMutations({ force: true });

        expect(mockedPush).not.toHaveBeenCalled();
        expect(await getPendingMutationCount()).toBe(0);
        expect((await get(id))?.version).toBe(3);
    });

    it("drain: an acknowledged file purge strips its embeds, a refused one does not", async () => {
        const acked = newId();
        const refused = newId();
        await seedLocal({ id: acked, type: "file", version: 1, purged_at: 1700000000 });
        await seedLocal({ id: refused, type: "file", version: 1, purged_at: 1700000000 });
        await enqueueMutation(acked, "delete");
        await enqueueMutation(refused, "delete");
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [
                {
                    id: refused,
                    current_item: {
                        ...wireItem({ id: refused, type: "file", version: 2 }),
                        user_id: "u",
                    },
                },
            ],
            errors: [],
        } as never);

        await pushPendingMutations({ force: true });

        expect(fileBridge.cleanupOrphanedFileRefs).toHaveBeenCalledWith([acked]);
        expect(await get(acked)).toBeUndefined();
        expect((await get(refused))?.version).toBe(2);
        expect(await getPendingMutationCount()).toBe(0);
    });
});

describe("terminal per-item rejections are parked instead of retried forever", () => {
    it("'Referenced chunk set is not committed' → parked with sync_error after 3 drains, the content kept", async () => {
        const id = newId();
        await seedLocal({
            id,
            type: "file",
            version: 1,
            dirty: true,
            localRev: 0,
            encrypted_payload: "p",
        });
        await enqueueMutation(id, "upsert");
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [],
            errors: [{ id, error: "Referenced chunk set is not committed" }],
        } as never);

        await pushPendingMutations({ force: true });
        await pushPendingMutations({ force: true });
        expect(await getPendingMutationCount()).toBe(1); // still retrying
        await pushPendingMutations({ force: true });

        expect(await getPendingMutationCount()).toBe(0);
        const item = await get(id);
        expect(item?.sync_error).toBe("Referenced chunk set is not committed");
        expect(item?.dirty).toBe(true); // the content is kept, a pull must not overwrite it
        expect(syncStore.noteParkedFailure).toHaveBeenCalled();
    });

    it("'hard_limit_exceeded' keeps retrying — it resolves once the user frees space", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: true, localRev: 0 });
        await enqueueMutation(id, "upsert");
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [],
            errors: [{ id, error: "hard_limit_exceeded" }],
        } as never);

        for (let i = 0; i < 4; i++) await pushPendingMutations({ force: true });

        expect(await getPendingMutationCount()).toBe(1);
        expect((await get(id))?.sync_error).toBeUndefined();
    });
});

describe("server writes carry localRev forward (never reset it)", () => {
    // Regression: wireToLocalItem produced a row without localRev, so every pull overwrite and every
    // 409 resolution reset it to undefined. Two consumers broke on that: the item-service CAS
    // (`?? 0` cannot tell a reset apart from a never-edited row, so a save whose decrypt was in
    // flight clobbered the fresh server version) and history's snapshot marker (edits counted from
    // 1 again and stayed below the stored marker, so snapshots silently stopped).
    it("pull overwrite of a clean row bumps localRev instead of dropping it", async () => {
        const id = newId();
        await seedLocal({ id, version: 1, dirty: false, localRev: 40 });
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 5, encrypted_payload: "server-v5" })],
            deleted: [],
            server_time: 100,
        } as never);

        await pullAndMerge();

        const row = await get(id);
        expect(row?.version).toBe(5);
        expect(row?.encrypted_payload).toBe("server-v5");
        expect(row?.dirty).toBe(false);
        expect(row?.localRev).toBe(41);
    });

    it("409 resolution (server becomes main) bumps localRev instead of dropping it", async () => {
        const id = newId();
        await seedLocal({ id, version: 5, dirty: true, localRev: 10, encrypted_payload: "local" });
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [
                {
                    id,
                    current_item: {
                        ...wireItem({ id, version: 6, encrypted_payload: "server-v6" }),
                        user_id: "u",
                    },
                },
            ],
            errors: [],
        } as never);
        mockedIsIdentical.mockResolvedValueOnce(true);

        await pushItem({ id } as LocalItem);

        const row = await get(id);
        expect(row?.version).toBe(6);
        expect(row?.encrypted_payload).toBe("server-v6");
        expect(row?.dirty).toBe(false);
        expect(row?.localRev).toBe(11);
    });
});

describe("a local tombstone is never copied into a conflict copy", () => {
    // Regression: offline trash (dirty=true) then offline permanent delete left a row with purged_at
    // AND dirty. When the other device (or GC retention) purged it first, the pull's tombstone
    // branches saw `dirty` and built a conflict copy of it — a permanently deleted note came back as
    // a live "[Conflict …]" item at the root.
    it("items[] purged_at tombstone + local purged_at + stale dirty → no copy, the row is removed", async () => {
        const id = newId();
        await seedLocal({
            id,
            version: 2,
            dirty: true,
            deleted_at: 1700000000,
            purged_at: 1700000001,
            encrypted_payload: "still-here",
        });
        mockedPull.mockResolvedValue({
            items: [wireItem({ id, version: 3, deleted_at: 1700000000, purged_at: 1700000005 })],
            deleted: [],
            server_time: 100,
        } as never);

        await pullAndMerge();

        expect(await get(id)).toBeUndefined();
        expect(mockedCreateForItem).not.toHaveBeenCalled();
        expect(mockedConflictAdd).not.toHaveBeenCalled();
    });

    it("deleted-log entry + local purged_at + stale dirty → no copy, the row is removed", async () => {
        const id = newId();
        await seedLocal({
            id,
            version: 2,
            dirty: true,
            deleted_at: 1700000000,
            purged_at: 1700000001,
            encrypted_payload: "still-here",
        });
        mockedPull.mockResolvedValue({
            items: [],
            deleted: [{ id, deleted_at: 1700000005 }],
            server_time: 100,
        } as never);

        await pullAndMerge();

        expect(await get(id)).toBeUndefined();
        expect(mockedCreateForItem).not.toHaveBeenCalled();
        expect(mockedConflictAdd).not.toHaveBeenCalled();
    });
});

describe("applyConflict drops the search doc of a discarded L1 copy", () => {
    it("localRev race: the stale L1 copy is removed from the index, the L2 copy stays", async () => {
        const id = newId();
        await seedLocal({
            id,
            version: 1,
            dirty: true,
            localRev: 0,
            encrypted_payload: "local-L1",
        });
        mockedPush.mockResolvedValue({
            succeeded: [],
            conflicts: [
                {
                    id,
                    current_item: {
                        ...wireItem({ id, version: 5, encrypted_payload: "server-S" }),
                        user_id: "u",
                    },
                },
            ],
            errors: [],
        } as never);
        mockedIsIdentical.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
        mockedCreateForItem.mockImplementation(async (item: LocalItem) => {
            if (item.encrypted_payload === "local-L1") {
                const db = await getDB();
                const cur = await db.get("items", id);
                if (cur) {
                    cur.localRev = 2;
                    cur.encrypted_payload = "local-L2";
                    cur.dirty = true;
                    await db.put("items", cur);
                }
                return { item: conflictCopy("copy-L1-idx", "note"), title: "L1" };
            }
            return { item: conflictCopy("copy-L2-idx", "note"), title: "L2" };
        });

        await pushItem({ id } as LocalItem);

        const mockedRemoveDoc = vi.mocked(removeDoc);
        expect(mockedRemoveDoc).toHaveBeenCalledWith("copy-L1-idx");
        expect(mockedRemoveDoc).not.toHaveBeenCalledWith("copy-L2-idx");
        expect(await get("copy-L1-idx")).toBeUndefined();
        expect(await get("copy-L2-idx")).toBeDefined();
    });
});

describe("push activity is visible to the sync chip", () => {
    const begin = vi.mocked(syncStore.beginPush);
    const end = vi.mocked(syncStore.endPush);

    async function seedDirtyNote(id: string) {
        await seedLocal({
            id,
            dirty: true,
            localRev: 1,
            encrypted_payload: "A".repeat(100),
            payload_nonce: "A".repeat(32),
            encrypted_item_key: "C".repeat(64),
            item_key_nonce: "B".repeat(32),
        });
    }

    it("pushItem on a dirty item brackets pushBatch with beginPush/endPush", async () => {
        const id = newId();
        await seedDirtyNote(id);
        mockedPush.mockResolvedValue({
            succeeded: [{ id, version: 2, updated_at: 2, created_at: 1 }],
            conflicts: [],
            errors: [],
        } as never);

        await pushItem((await get(id)) as LocalItem);

        expect(begin).toHaveBeenCalledOnce();
        expect(end).toHaveBeenCalledOnce();
        const pushOrder = mockedPush.mock.invocationCallOrder[0] ?? 0;
        expect(begin.mock.invocationCallOrder[0]).toBeLessThan(pushOrder);
        expect(end.mock.invocationCallOrder[0]).toBeGreaterThan(pushOrder);
    });

    it("endPush still runs when pushBatch throws (the item goes to the queue)", async () => {
        const id = newId();
        await seedDirtyNote(id);
        mockedPush.mockRejectedValue(new Error("Network error"));

        await pushItem((await get(id)) as LocalItem);

        expect(begin).toHaveBeenCalledOnce();
        expect(end).toHaveBeenCalledOnce();
        expect(await getPendingMutationCount()).toBe(1);
    });

    it("pushItem on a clean item does not signal a push at all", async () => {
        const id = newId();
        await seedLocal({ id, dirty: false });

        await pushItem((await get(id)) as LocalItem);

        expect(mockedPush).not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
    });

    it("pushDeletes brackets its batch with beginPush/endPush", async () => {
        const id = newId();
        await seedLocal({ id, purged_at: 5 });
        mockedPush.mockResolvedValue({ succeeded: [], conflicts: [], errors: [] } as never);

        await pushDeletes([id]);

        expect(begin).toHaveBeenCalledOnce();
        expect(end).toHaveBeenCalledOnce();
    });

    it("a drain signals a push only when a mutation is due", async () => {
        await pushPendingMutations();
        expect(begin).not.toHaveBeenCalled();

        const waiting = newId();
        await seedDirtyNote(waiting);
        const db = await getDB();
        await db.put("mutation-queue", {
            id: waiting,
            type: "upsert",
            attempted_at: Date.now(),
            attempt_count: 5,
        });
        await pushPendingMutations();
        expect(begin).not.toHaveBeenCalled();

        const due = newId();
        await seedDirtyNote(due);
        await enqueueMutation(due, "upsert");
        mockedPush.mockResolvedValue({
            succeeded: [{ id: due, version: 2, updated_at: 2, created_at: 1 }],
            conflicts: [],
            errors: [],
        } as never);
        await pushPendingMutations();
        expect(begin).toHaveBeenCalledOnce();
        expect(end).toHaveBeenCalledOnce();
    });
});

describe("mutationRetryAt — one due time for the drain, the timer and the panel", () => {
    const BASES = [1_000, 5_000, 15_000, 60_000, 300_000];

    it("a fresh mutation is due at once", () => {
        expect(mutationRetryAt({ id: "x", attempt_count: 0, attempted_at: 123 })).toBe(0);
    });

    it("is deterministic and stays inside [base × 0.8, base × 1.2] (rounded up to whole ms)", () => {
        for (let attempt = 1; attempt <= 7; attempt++) {
            const base = BASES[Math.min(attempt - 1, BASES.length - 1)] ?? 0;
            for (const id of ["a", "b", "0192f0c4-7d3e-7000-8000-000000000001"]) {
                const m = { id, attempt_count: attempt, attempted_at: 1_000_000 };
                const at = mutationRetryAt(m);
                expect(mutationRetryAt(m)).toBe(at);
                expect(at - 1_000_000).toBeGreaterThanOrEqual(base * 0.8);
                expect(at - 1_000_000).toBeLessThanOrEqual(base * 1.2);
                expect(Number.isInteger(at)).toBe(true);
            }
        }
    });

    it("the drain skips a mutation 1 ms before its due time and pushes it at that time", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            const id = newId();
            await seedLocal({
                id,
                dirty: true,
                localRev: 1,
                encrypted_payload: "A".repeat(100),
                payload_nonce: "A".repeat(32),
                encrypted_item_key: "C".repeat(64),
                item_key_nonce: "B".repeat(32),
            });
            const row = { id, type: "upsert" as const, attempted_at: 1_000_000, attempt_count: 2 };
            await (await getDB()).put("mutation-queue", row);
            const dueAt = mutationRetryAt(row);
            expect(await nextMutationRetryAt()).toBe(dueAt);
            mockedPush.mockResolvedValue({
                succeeded: [{ id, version: 2, updated_at: 2, created_at: 1 }],
                conflicts: [],
                errors: [],
            } as never);

            vi.setSystemTime(dueAt - 1);
            await pushPendingMutations();
            expect(mockedPush).not.toHaveBeenCalled();

            vi.setSystemTime(dueAt);
            await pushPendingMutations();
            expect(mockedPush).toHaveBeenCalledOnce();
            expect(await nextMutationRetryAt()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("nextMutationRetryAt returns the earliest due time in the queue", async () => {
        const db = await getDB();
        const later = {
            id: "later",
            type: "upsert" as const,
            attempted_at: 5_000,
            attempt_count: 4,
        };
        const sooner = {
            id: "sooner",
            type: "upsert" as const,
            attempted_at: 5_000,
            attempt_count: 1,
        };
        await db.put("mutation-queue", later);
        await db.put("mutation-queue", sooner);

        expect(await nextMutationRetryAt()).toBe(mutationRetryAt(sooner));
    });
});

describe("onMutationQueueChanged", () => {
    it("fires after an enqueue and after a drain, and stops after unsubscribe", async () => {
        const listener = vi.fn();
        const unsubscribe = onMutationQueueChanged(listener);
        try {
            const id = newId();
            await seedLocal({ id, dirty: true, localRev: 1, encrypted_payload: "A".repeat(100) });
            await enqueueMutation(id, "upsert");
            expect(listener).toHaveBeenCalledTimes(1);

            mockedPush.mockRejectedValue(new Error("Network error"));
            await pushPendingMutations();
            expect(listener).toHaveBeenCalledTimes(2);
        } finally {
            unsubscribe();
        }
        await enqueueMutation(newId(), "delete");
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
