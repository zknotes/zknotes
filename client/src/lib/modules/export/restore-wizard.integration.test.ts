import "fake-indexeddb/auto";
import type { RestoreStagedItem } from "@zknotes/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pending = { count: 0 };
const stagedIds: string[] = [];
/** Copies, not the batches themselves — the wizard empties a batch once it is sent. */
const stagedItems: RestoreStagedItem[] = [];
const restoreApi = vi.hoisted(() => {
    const sessions = new Map<
        string,
        {
            backup_hash: string;
            mode: string;
            /** The manifest's ids — what the server expects staged (no purged entries here). */
            manifest: string[];
            staged: Set<string>;
            status: string;
            verdict: Record<string, unknown>;
        }
    >();
    /** The ids the next preflight reports as purged on the server. */
    const purged: string[] = [];
    /** The next preflight's collisions, their versions and resolved remaps. */
    const live: string[] = [];
    const trashed: string[] = [];
    const expected: Record<string, number> = {};
    const remaps: Record<string, string> = {};
    return { sessions, purged, live, trashed, expected, remaps };
});

vi.mock("$lib/core/sync/store.svelte", () => ({
    syncStore: {
        get pendingCount() {
            return pending.count;
        },
        suspendSync: vi.fn(),
        resumeSync: vi.fn(),
        refreshPendingCount: vi.fn(),
    },
}));

vi.mock("$lib/core/workers/crypto-rpc", () => ({
    encryptPayloadWithNewKeyTask: vi.fn(async (id: string) => ({
        encryptedItemKey: new Uint8Array([1]),
        itemKeyNonce: new Uint8Array([2]),
        ciphertext: new Uint8Array([3, 4]),
        nonce: new Uint8Array([5]),
    })),
    // An overwritten item is sealed with its existing key.
    addCachedItemKey: vi.fn(async () => undefined),
    encryptPayloadTask: vi.fn(async () => ({
        ciphertext: new Uint8Array([7, 7]),
        nonce: new Uint8Array([8]),
    })),
}));

vi.mock("$lib/core/api/restore", () => {
    class RestoreClientError extends Error {
        constructor(
            message: string,
            public readonly status: number,
            public readonly body: Record<string, unknown>,
        ) {
            super(message);
            this.name = "RestoreClientError";
        }
    }
    const emptyVerdict = {
        ok: true,
        blockers: [],
        mode: "overwrite_all",
        counts: {
            manifest_items: 1,
            collide_live: 0,
            collide_trashed: 0,
            collide_purged: 0,
            creates: 1,
            overwrites: 0,
            skips: 0,
        },
        collisions: { live: [], trashed: [], purged: [] },
        orphan_parents: [],
        quota: {
            current_used: 0,
            quota: 1_000_000,
            peak_used: 10,
            peak_allowed: 2_000_000,
            peak_ok: true,
            final_used: 10,
            final_shortfall: 0,
            final_ok: true,
        },
        ceilings: {
            items: { current: 0, incoming_creates: 1, limit: 100_000, ok: true },
            files: { current: 0, incoming_creates: 0, limit: 50_000, ok: true },
        },
        blobs: { count: 0, bytes: 0 },
        expected_versions: {},
    };
    return {
        RestoreClientError,
        createRestoreSession: vi.fn(
            async (input: {
                backup_hash: string;
                mode: string;
                manifest: Array<{ id: string }>;
            }) => {
                const open = [...restoreApi.sessions.values()].find((s) => s.status === "open");
                if (open) {
                    const id = [...restoreApi.sessions.entries()].find(([, s]) => s === open)![0];
                    throw new RestoreClientError("restore_already_open", 409, {
                        error: "restore_already_open",
                        restore_session_id: id,
                    });
                }
                const id = "sess-1";
                const verdict = {
                    ...emptyVerdict,
                    mode: input.mode,
                    collisions: {
                        ...emptyVerdict.collisions,
                        purged: [...restoreApi.purged],
                        live: [...restoreApi.live],
                        trashed: [...restoreApi.trashed],
                    },
                    expected_versions: { ...restoreApi.expected },
                    remaps: { ...restoreApi.remaps },
                };
                restoreApi.sessions.set(id, {
                    backup_hash: input.backup_hash,
                    mode: input.mode,
                    manifest: input.manifest.map((m) => m.id),
                    staged: new Set(),
                    status: "open",
                    verdict,
                });
                return { restore_session_id: id, verdict };
            },
        ),
        getRestoreSession: vi.fn(async (id: string) => {
            const s = restoreApi.sessions.get(id);
            if (!s) throw new RestoreClientError("not_found", 404, { error: "not_found" });
            const missingItems = s.manifest.filter((i) => !s.staged.has(i));
            return {
                restore_session_id: id,
                status: s.status,
                backup_hash: s.backup_hash,
                mode: s.mode,
                staged_items: s.staged.size,
                staged_blobs: 0,
                missing: { items: missingItems, blobs: [] },
                verdict: s.verdict,
                expires_at: Date.now() / 1000 + 1800,
            };
        }),
        stageRestoreItems: vi.fn(async (id: string, items: RestoreStagedItem[]) => {
            const s = restoreApi.sessions.get(id)!;
            let staged = 0;
            let skipped = 0;
            for (const item of items) {
                if (s.staged.has(item.id)) skipped++;
                else {
                    s.staged.add(item.id);
                    staged++;
                    stagedIds.push(item.id);
                    stagedItems.push({ ...item });
                }
            }
            return { staged, skipped };
        }),
        pingRestoreSession: vi.fn(async () => ({ ok: true })),
        verifyRestoreSession: vi.fn(async () => ({
            ok: true,
            blockers: [],
            verdict: emptyVerdict,
            missing: { items: [], blobs: [] },
            version_drift: [],
        })),
        commitRestoreSession: vi.fn(async (id: string) => {
            const s = restoreApi.sessions.get(id);
            if (s) s.status = "committed";
            return { ok: true };
        }),
        abortRestoreSession: vi.fn(async (id: string) => {
            const s = restoreApi.sessions.get(id);
            if (s) s.status = "aborted";
            return { ok: true };
        }),
    };
});

const pullAndMergeMock = vi.fn(async (_opts?: { replaceLocal?: boolean }) => ({
    itemCount: 1,
    changedIds: ["note-1"],
}));
vi.mock("$lib/core/sync/engine", () => ({
    pullAndMerge: (opts?: { replaceLocal?: boolean }) => pullAndMergeMock(opts),
}));

vi.mock("$lib/core/events/file-bridge", () => ({
    fileBridge: {
        stageRestoreUpload: vi.fn(),
    },
}));

vi.mock("$lib/core/files/pin-manager-state.svelte", () => ({
    pinManager: { roots: [] as string[] },
}));

vi.mock("$lib/core/stores/recent-notes.svelte", () => ({
    recentNotesStore: { ids: [] as string[] },
}));

import { RESTORE_LIMITS, restoreRemapId } from "@zknotes/shared";
import { getRestoreSession, stageRestoreItems, verifyRestoreSession } from "$lib/core/api/restore";
import { getDB, type LocalItem } from "$lib/core/db";
import {
    addCachedItemKey,
    encryptPayloadTask,
    encryptPayloadWithNewKeyTask,
} from "$lib/core/workers/crypto-rpc";
import { fileBridge } from "$lib/core/events/file-bridge";
import { STORAGE_KEYS } from "$lib/core/utils/persisted";
import type { BackupFile, BackupFolder, BackupNote } from "./full-backup";
import {
    beginRestore,
    clearRestoreUiKeys,
    executeRestore,
    hashBackupBytes,
    noteOrFolderPayload,
    resumeRestore,
} from "./restore-wizard";

const note: BackupNote = {
    id: "note-1",
    type: "note",
    parent_id: null,
    sort_order: "a",
    title: "Hello",
    content: "<p>hi</p>",
    created_at: 1,
    updated_at: 1,
    version: 1,
};

function parsed() {
    return { items: [note], fileMap: new Map<string, Uint8Array>() };
}

/** The note plus `count` attachments hanging off it, each with its bytes. */
function parsedWithFiles(count: number) {
    const files: BackupFile[] = Array.from({ length: count }, (_, i) => ({
        id: `file-${i}`,
        type: "file",
        parent_id: note.id,
        sort_order: `b${i}`,
        name: `file-${i}.bin`,
        mime: "application/octet-stream",
        size: 3,
        created_at: 1,
        updated_at: 1,
        version: 1,
    }));
    const fileMap = new Map(files.map((f) => [f.id, new Uint8Array([1, 2, 3])]));
    return { items: [note, ...files], fileMap };
}

describe("restore wizard", () => {
    beforeEach(async () => {
        pending.count = 0;
        stagedIds.length = 0;
        stagedItems.length = 0;
        restoreApi.sessions.clear();
        restoreApi.purged.length = 0;
        restoreApi.live.length = 0;
        restoreApi.trashed.length = 0;
        for (const key of Object.keys(restoreApi.expected)) delete restoreApi.expected[key];
        for (const key of Object.keys(restoreApi.remaps)) delete restoreApi.remaps[key];
        pullAndMergeMock.mockClear();
        vi.clearAllMocks();
        const db = await getDB();
        await db.clear("items");
        await db.clear("metadata");
        await db.clear("mutation-queue");
    });

    it("refuses to start while pendingCount > 0", async () => {
        pending.count = 3;
        const hash = await hashBackupBytes(new Uint8Array([1, 2, 3]));
        const result = await beginRestore({
            parsed: parsed(),
            backupHash: hash,
            mode: "overwrite_all",
        });
        expect(result.status).toBe("pending_unsynced");
        if (result.status === "pending_unsynced") expect(result.pendingCount).toBe(3);
        expect(restoreApi.sessions.size).toBe(0);
    });

    it("five phases: preflight → stage → verify → commit → replaceLocal", async () => {
        const hash = await hashBackupBytes(new Uint8Array([9, 9, 9]));
        const began = await beginRestore({
            parsed: parsed(),
            backupHash: hash,
            mode: "overwrite_all",
        });
        expect(began.status).toBe("preflight");
        if (began.status !== "preflight") return;
        const result = await executeRestore(began.session);
        expect(result.status).toBe("done");
        expect(stagedIds).toEqual(["note-1"]);
        expect(pullAndMergeMock).toHaveBeenCalledWith({ replaceLocal: true });
    });

    // The 2026-09-26 incident read "Staging notes 17/23" while every note was done
    // and an attachment was uploading — the label only changed once the first file had finished.
    it("switches the label to Staging files before the first attachment finishes", async () => {
        const labelsAtUpload: Array<{ label: string; done: number }> = [];
        let last = { label: "", done: 0 };
        vi.mocked(fileBridge.stageRestoreUpload).mockImplementation(async (args) => {
            labelsAtUpload.push({ ...last });
            return { id: args.itemId } as Awaited<ReturnType<typeof fileBridge.stageRestoreUpload>>;
        });

        const began = await beginRestore({
            parsed: parsedWithFiles(2),
            backupHash: await hashBackupBytes(new Uint8Array([7, 1])),
            mode: "overwrite_all",
        });
        expect(began.status).toBe("preflight");
        if (began.status !== "preflight") return;
        await executeRestore(began.session, (p) => {
            last = { label: p.label, done: p.done };
        });

        expect(labelsAtUpload[0]).toEqual({ label: "Staging files", done: 1 });
    });

    // Promise.all rejects on the first failure, but without a stop the other workers
    // went on taking files — uploading behind an error the user had already been shown.
    it("starts no further attachment once one has failed", async () => {
        const limit = RESTORE_LIMITS.MAX_PARALLEL_STAGING_UPLOADS;
        let calls = 0;
        vi.mocked(fileBridge.stageRestoreUpload).mockImplementation(async (args) => {
            calls++;
            if (calls === 1) throw new Error("Upload failed: 400 Bad Request (InvalidDigest)");
            await new Promise((r) => setTimeout(r, 5));
            return { id: args.itemId } as Awaited<ReturnType<typeof fileBridge.stageRestoreUpload>>;
        });

        const began = await beginRestore({
            parsed: parsedWithFiles(limit + 3),
            backupHash: await hashBackupBytes(new Uint8Array([7, 2])),
            mode: "overwrite_all",
        });
        expect(began.status).toBe("preflight");
        if (began.status !== "preflight") return;
        await expect(executeRestore(began.session)).rejects.toThrow("InvalidDigest");

        // Give the workers that were already mid-file time to finish and, without the stop, reach
        // for the next file.
        await new Promise((r) => setTimeout(r, 50));
        expect(calls).toBe(limit);
    });

    // The server accepts an id outside the manifest only as the proven remap of a
    // purged original, so every remapped item has to name that original — and nothing else may.
    it("stages a purged item under its remap and names the original; the rest name nothing", async () => {
        const folder: BackupFolder = {
            id: "01920f3e-7a4b-7c2d-9e1f-000000000001",
            type: "folder",
            parent_id: null,
            sort_order: "a",
            title: "Purged folder",
            created_at: 1,
            updated_at: 1,
            version: 1,
        };
        const child: BackupNote = {
            ...note,
            id: "01920f3e-7a4b-7c2d-9e1f-000000000002",
            parent_id: folder.id,
        };
        const attachment: BackupFile = {
            id: "01920f3e-7a4b-7c2d-9e1f-000000000003",
            type: "file",
            parent_id: child.id,
            sort_order: "b",
            name: "pic.png",
            mime: "image/png",
            size: 3,
            created_at: 1,
            updated_at: 1,
            version: 1,
        };
        restoreApi.purged.push(folder.id, attachment.id);
        vi.mocked(fileBridge.stageRestoreUpload).mockImplementation(
            async (args) =>
                ({ id: args.itemId, type: "file", parent_id: args.parentId }) as Awaited<
                    ReturnType<typeof fileBridge.stageRestoreUpload>
                >,
        );

        const hash = await hashBackupBytes(new Uint8Array([1, 1, 9]));
        const began = await beginRestore({
            parsed: {
                items: [folder, child, attachment],
                fileMap: new Map([[attachment.id, new Uint8Array([1, 2, 3])]]),
            },
            backupHash: hash,
            mode: "skip_existing",
        });
        expect(began.status).toBe("preflight");
        if (began.status !== "preflight") return;
        expect((await executeRestore(began.session)).status).toBe("done");

        const staged = new Map(stagedItems.map((item) => [item.id, item]));
        const newFolder = restoreRemapId(hash, folder.id);
        const newAttachment = restoreRemapId(hash, attachment.id);
        expect([...staged.keys()].sort()).toEqual([child.id, newAttachment, newFolder].sort());
        expect(staged.get(newFolder)?.remapped_from).toBe(folder.id);
        expect(staged.get(newAttachment)?.remapped_from).toBe(attachment.id);
        expect(staged.get(child.id)).not.toHaveProperty("remapped_from");
        expect(staged.get(child.id)?.parent_id).toBe(newFolder);
    });

    // A share link wraps the item's own Item Key, so Overwrite all must seal the restored
    // content with that key rather than a new one.
    describe("Overwrite all keeps the existing Item Key", () => {
        // "KEEP-WRAP" and "KEEP-NONCE": what the device's copy of the item holds.
        const WRAP = "S0VFUC1XUkFQ";
        const NONCE = "S0VFUC1OT05DRQ==";

        async function localCopy(id: string, extra: Partial<LocalItem> = {}) {
            const db = await getDB();
            await db.put("items", {
                id,
                type: "note",
                parent_id: null,
                encrypted_payload: "b2xk",
                payload_nonce: "bm9uY2U=",
                encrypted_item_key: WRAP,
                item_key_nonce: NONCE,
                sort_order: "a",
                version: 3,
                ...extra,
            } as LocalItem);
        }

        async function run(mode: "overwrite_all" | "skip_existing") {
            const began = await beginRestore({
                parsed: parsed(),
                backupHash: await hashBackupBytes(new Uint8Array([2, 4, mode.length])),
                mode,
            });
            if (began.status !== "preflight") throw new Error("expected preflight");
            return executeRestore(began.session);
        }

        it("a live collision is staged under its own wrap, sealed with that key", async () => {
            await localCopy("note-1");
            restoreApi.live.push("note-1");
            restoreApi.expected["note-1"] = 3;

            expect((await run("overwrite_all")).status).toBe("done");

            expect(stagedItems).toHaveLength(1);
            expect(stagedItems[0]).toMatchObject({
                id: "note-1",
                encrypted_item_key: WRAP,
                item_key_nonce: NONCE,
                version: 3,
            });
            expect(addCachedItemKey).toHaveBeenCalledWith(
                "note-1",
                expect.any(Uint8Array),
                expect.any(Uint8Array),
            );
            expect(encryptPayloadTask).toHaveBeenCalledWith("note-1", expect.anything(), 3);
            expect(encryptPayloadWithNewKeyTask).not.toHaveBeenCalled();
        });

        it("so is a collision in the Trash", async () => {
            await localCopy("note-1", { deleted_at: 100 });
            restoreApi.trashed.push("note-1");

            expect((await run("overwrite_all")).status).toBe("done");

            expect(stagedItems[0]).toMatchObject({
                encrypted_item_key: WRAP,
                item_key_nonce: NONCE,
            });
            expect(encryptPayloadWithNewKeyTask).not.toHaveBeenCalled();
        });

        it("an item that is not a collision still gets a new key", async () => {
            await localCopy("note-1");

            expect((await run("overwrite_all")).status).toBe("done");

            expect(encryptPayloadWithNewKeyTask).toHaveBeenCalledWith(
                "note-1",
                expect.anything(),
                1,
            );
            expect(stagedItems[0]?.encrypted_item_key).not.toBe(WRAP);
            expect(addCachedItemKey).not.toHaveBeenCalled();
        });

        it("a collision this device has no copy of, even after a pull, stops before staging", async () => {
            restoreApi.live.push("note-1");
            pullAndMergeMock.mockClear();

            await expect(run("overwrite_all")).rejects.toThrow(
                "This device does not have 1 of the items this restore would overwrite",
            );
            expect(pullAndMergeMock).toHaveBeenCalledOnce();
            expect(stageRestoreItems).not.toHaveBeenCalled();
        });

        it("Skip existing leaves collisions out, so it never needs their keys", async () => {
            restoreApi.live.push("note-1");
            pullAndMergeMock.mockClear();

            expect((await run("skip_existing")).status).toBe("done");

            expect(stagedItems).toEqual([]);
            // Only the final replace-local pull ran, not the key-filling one.
            expect(pullAndMergeMock.mock.calls).toEqual([[{ replaceLocal: true }]]);
        });
    });

    // The server resolves the id a purged entry comes back under, and reports that id as a
    // collision when an earlier restore's copy of it still exists.
    describe("remaps resolved by the server", () => {
        const purgedNote: BackupNote = {
            ...note,
            id: "01920f3e-7a4b-7c2d-9e1f-000000000011",
        };

        it("stages under the server's remap, a later generation included", async () => {
            const nextGeneration = "0199a1b2-c3d4-7e5f-8a6b-000000000022";
            restoreApi.purged.push(purgedNote.id);
            restoreApi.remaps[purgedNote.id] = nextGeneration;

            const began = await beginRestore({
                parsed: { items: [purgedNote], fileMap: new Map() },
                backupHash: await hashBackupBytes(new Uint8Array([1, 2, 9])),
                mode: "skip_existing",
            });
            if (began.status !== "preflight") throw new Error("expected preflight");
            expect((await executeRestore(began.session)).status).toBe("done");

            expect(stagedItems.map((i) => [i.id, i.remapped_from])).toEqual([
                [nextGeneration, purgedNote.id],
            ]);
        });

        it("under Skip existing, leaves out a remap target the server reports as existing", async () => {
            const copy = "0199a1b2-c3d4-7e5f-8a6b-000000000033";
            restoreApi.purged.push(purgedNote.id);
            restoreApi.remaps[purgedNote.id] = copy;
            restoreApi.live.push(copy);

            const began = await beginRestore({
                parsed: { items: [purgedNote], fileMap: new Map() },
                backupHash: await hashBackupBytes(new Uint8Array([1, 2, 10])),
                mode: "skip_existing",
            });
            if (began.status !== "preflight") throw new Error("expected preflight");
            expect((await executeRestore(began.session)).status).toBe("done");

            expect(stagedItems).toEqual([]);
        });
    });

    // "Confirm restore" again after an error runs the same ActiveRestore a second time.
    // Its `missing` is still the preflight's empty list, so the retry used to send nothing.
    describe("a second attempt on the same session", () => {
        async function begin(fileCount: number) {
            const began = await beginRestore({
                parsed: parsedWithFiles(fileCount),
                backupHash: await hashBackupBytes(new Uint8Array([4, 4, fileCount])),
                mode: "overwrite_all",
            });
            if (began.status !== "preflight") throw new Error("expected preflight");
            return began.session;
        }

        it("sends the attachment that failed the first time", async () => {
            let calls = 0;
            vi.mocked(fileBridge.stageRestoreUpload).mockImplementation(async (args) => {
                calls++;
                if (calls === 1) throw new Error("network down");
                return { id: args.itemId } as Awaited<
                    ReturnType<typeof fileBridge.stageRestoreUpload>
                >;
            });
            const session = await begin(1);
            await expect(executeRestore(session)).rejects.toThrow("network down");
            expect(session.stagedIds).toEqual(["note-1"]);

            expect((await executeRestore(session)).status).toBe("done");
            expect(calls).toBe(2);
            expect(stagedIds).toEqual(["note-1", "file-0"]);
        });

        it("after a blocked verify, sends what the server still lacks", async () => {
            vi.mocked(fileBridge.stageRestoreUpload).mockImplementation(
                async (args) =>
                    ({ id: args.itemId }) as Awaited<
                        ReturnType<typeof fileBridge.stageRestoreUpload>
                    >,
            );
            const session = await begin(1);
            vi.mocked(verifyRestoreSession).mockResolvedValueOnce({
                ok: false,
                blockers: [{ code: "incomplete_staging" }],
                verdict: session.verdict,
                missing: { items: ["file-0"], blobs: [] },
                version_drift: [],
            });
            expect((await executeRestore(session)).status).toBe("blocked");
            // The server does not hold the attachment (dropped from its staging, say).
            restoreApi.sessions.get(session.sessionId)!.staged.delete("file-0");
            // `stagedIds` records what the server newly accepts (the batches themselves are emptied).
            stagedIds.length = 0;

            expect((await executeRestore(session)).status).toBe("done");
            expect(stagedIds).toEqual(["file-0"]);
        });

        it("a first attempt on a new session asks the server nothing extra", async () => {
            const session = await begin(0);
            vi.mocked(getRestoreSession).mockClear();

            expect((await executeRestore(session)).status).toBe("done");
            expect(getRestoreSession).not.toHaveBeenCalled();
        });

        it("attachments already uploading when one fails are staged, and a retry sends only the failed one", async () => {
            const started: string[] = [];
            const finished: string[] = [];
            let failNext = true;
            vi.mocked(fileBridge.stageRestoreUpload).mockImplementation(async (args) => {
                started.push(args.itemId);
                if (args.itemId === "file-0" && failNext) {
                    failNext = false;
                    await new Promise((r) => setTimeout(r, 1));
                    throw new Error("network down");
                }
                await new Promise((r) => setTimeout(r, 20));
                finished.push(args.itemId);
                return { id: args.itemId } as Awaited<
                    ReturnType<typeof fileBridge.stageRestoreUpload>
                >;
            });
            const session = await begin(3);

            await expect(executeRestore(session)).rejects.toThrow("network down");
            // The error is shown only once nothing of this attempt is still uploading, so no upload
            // of it overlaps with a retry the user starts.
            expect([...finished].sort()).toEqual(["file-1", "file-2"]);
            // What did arrive is staged, so the server no longer lists it as missing.
            expect(stagedIds).toEqual(expect.arrayContaining(["file-1", "file-2"]));

            started.length = 0;
            expect((await executeRestore(session)).status).toBe("done");
            expect(started).toEqual(["file-0"]);
        });

        it("a session that is no longer open stops with a readable error and stages nothing", async () => {
            vi.mocked(fileBridge.stageRestoreUpload).mockRejectedValueOnce(
                new Error("network down"),
            );
            const session = await begin(1);
            await expect(executeRestore(session)).rejects.toThrow("network down");
            restoreApi.sessions.get(session.sessionId)!.status = "expired";
            vi.mocked(stageRestoreItems).mockClear();
            vi.mocked(fileBridge.stageRestoreUpload).mockClear();

            await expect(executeRestore(session)).rejects.toThrow(
                "This restore has ended on the server",
            );
            expect(stageRestoreItems).not.toHaveBeenCalled();
            expect(fileBridge.stageRestoreUpload).not.toHaveBeenCalled();
        });
    });

    it("resuming with the same file sends only what is missing", async () => {
        const bytes = new Uint8Array([4, 5, 6]);
        const hash = await hashBackupBytes(bytes);
        const began = await beginRestore({
            parsed: parsed(),
            backupHash: hash,
            mode: "overwrite_all",
        });
        expect(began.status).toBe("preflight");
        if (began.status !== "preflight") return;

        const s = restoreApi.sessions.get(began.session.sessionId)!;
        s.staged.add("note-1");
        began.session.stagedIds = ["note-1"];

        stagedIds.length = 0;
        const resumed = await resumeRestore({ parsed: parsed(), backupHash: hash });
        expect(resumed.status).toBe("preflight");
        if (resumed.status !== "preflight") return;
        await executeRestore(resumed.session);
        expect(stagedIds).toEqual([]);
    });

    it("the wrong file is refused on the hash", async () => {
        const hashA = await hashBackupBytes(new Uint8Array([1]));
        const hashB = await hashBackupBytes(new Uint8Array([2]));
        const began = await beginRestore({
            parsed: parsed(),
            backupHash: hashA,
            mode: "overwrite_all",
        });
        expect(began.status).toBe("preflight");
        const resumed = await resumeRestore({ parsed: parsed(), backupHash: hashB });
        expect(resumed.status).toBe("wrong_backup");
    });

    it("dirty work during the staging prevents the wipe", async () => {
        const db = await getDB();
        await db.put("items", {
            id: "local-new",
            type: "note",
            parent_id: null,
            encrypted_payload: "x",
            payload_nonce: "y",
            encrypted_item_key: "k",
            item_key_nonce: "n",
            sort_order: "z",
            version: 1,
            dirty: true,
        } as LocalItem);

        const hash = await hashBackupBytes(new Uint8Array([7]));
        const began = await beginRestore({
            parsed: parsed(),
            backupHash: hash,
            mode: "overwrite_all",
        });
        if (began.status !== "preflight") throw new Error("expected preflight");
        const result = await executeRestore(began.session);
        expect(result.status).toBe("committed_dirty");
        if (result.status === "committed_dirty") {
            expect(result.leftoverDirty).toContain("local-new");
        }
        expect(pullAndMergeMock).toHaveBeenCalledOnce();
        expect(pullAndMergeMock.mock.calls[0]?.[0]?.replaceLocal).not.toBe(true);
    });

    it("the theme and the zoom survive; recents/pins/expand are cleared", () => {
        const mem: Record<string, string> = {
            theme: "dark",
            cn_ui_zoom: "120",
            cn_recent_emojis: '["😀"]',
            cn_sidebar_width: "280",
            cn_recent_notes: '["abc"]',
            "zknotes:pinned-items": '["p1"]',
            f_folder1: "1",
        };
        const old = globalThis.localStorage;
        globalThis.localStorage = {
            getItem: (k) => mem[k] ?? null,
            setItem: (k, v) => {
                mem[k] = String(v);
            },
            removeItem: (k) => {
                delete mem[k];
            },
            clear: () => {
                for (const k of Object.keys(mem)) delete mem[k];
            },
            get length() {
                return Object.keys(mem).length;
            },
            key: (i) => Object.keys(mem)[i] ?? null,
        };

        clearRestoreUiKeys();

        expect(mem.theme).toBe("dark");
        expect(mem[STORAGE_KEYS.uiZoom]).toBe("120");
        expect(mem[STORAGE_KEYS.recentEmojis]).toBe('["😀"]');
        expect(mem[STORAGE_KEYS.sidebarWidth]).toBe("280");
        expect(mem[STORAGE_KEYS.recentNotes]).toBeUndefined();
        expect(mem["zknotes:pinned-items"]).toBeUndefined();
        expect(mem.f_folder1).toBeUndefined();

        globalThis.localStorage = old;
    });

    it("noteOrFolderPayload preserves contentTitle and outlineVisible:false", () => {
        const withTitle: BackupNote = {
            ...note,
            id: "note-with-title",
            content: "<p>body</p>",
            contentTitle: "Derived title",
            outlineVisible: false,
        };
        expect(noteOrFolderPayload(withTitle)).toEqual({
            title: withTitle.title,
            content: withTitle.content,
            contentTitle: "Derived title",
            outlineVisible: false,
        });

        // When the original has no contentTitle, the reassembled payload must not gain one as "".
        const withoutTitle: BackupNote = { ...note, id: "note-without-title" };
        const reassembled = noteOrFolderPayload(withoutTitle);
        expect(reassembled).not.toHaveProperty("contentTitle");
        expect(reassembled).not.toHaveProperty("outlineVisible");
    });

    it("starred:false survives the reassembly rather than collapsing into an omitted field", () => {
        const unstarred: BackupNote = { ...note, id: "note-unstarred", starred: false };
        expect(noteOrFolderPayload(unstarred)).toMatchObject({ starred: false });

        const starred: BackupNote = { ...note, id: "note-starred", starred: true };
        expect(noteOrFolderPayload(starred)).toMatchObject({ starred: true });

        // An original that never carried starred (a legacy item, say) stays without the field, not "false".
        const neverStarred: BackupNote = { ...note, id: "note-never-starred" };
        expect(noteOrFolderPayload(neverStarred)).not.toHaveProperty("starred");
    });
});
