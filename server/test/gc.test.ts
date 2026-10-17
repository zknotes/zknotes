import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { FILE_LIMITS } from "@zknotes/shared";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { items, uploadSessions } from "../src/db/schema";
import { runDeepRepair, runGc } from "../src/gc";
import { S3_BUCKET, s3 } from "../src/s3";
import {
    countChunkSets,
    countDeletedLogRows,
    countFileChunks,
    countItemRows,
    countUploadSessions,
    getChunkSetPendingDeleteAt,
    getUploadSessionStatus,
    getUserStorageUsed,
    insertChunkSet,
    insertDeletedItem,
    insertDeletedLogEntry,
    insertFileChunk,
    insertLiveItem,
    insertTombstoneItem,
    insertUploadSession,
    insertUser,
    resetDb,
    setUserStorage,
} from "./helpers";

const nowSec = () => Math.floor(Date.now() / 1000);

describe("runGc — sections A+B (sessions)", () => {
    beforeEach(resetDb);

    test("an empty database → nothing to clean up", async () => {
        const result = await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 0 });
        expect(result).toEqual({
            authSessions: 0,
            signInFailures: 0,
            // Open-core has no extensions at all, so no GC step reports any counters.
            extensions: {},
            uploadSessions: 0,
            blobsPurged: 0,
            bytesReclaimed: 0,
            autoPurgedItems: 0,
            orphanChunkSetsMarked: 0,
            itemTombstones: 0,
            deletedLogRows: 0,
            shareLinksExpired: 0,
            shareLinksDeleted: 0,
            restoreSessions: 0,
        });
    });

    test("an aborted upload session older than the presigned PUT TTL is cleaned up", async () => {
        await insertUser();
        await insertUploadSession(
            "sess-1",
            "user-1",
            "aborted",
            nowSec() - FILE_LIMITS.PRESIGNED_PUT_EXPIRES_SEC - 10,
        );

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 3600 });

        expect(result.uploadSessions).toBe(1);
        expect(await countUploadSessions()).toBe(0);
    });

    test("a recently aborted upload session is kept until the presigned PUT TTL elapses", async () => {
        await insertUser();
        await insertUploadSession("sess-fresh-abort", "user-1", "aborted", nowSec() - 10);

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 3600 });

        expect(result.uploadSessions).toBe(0);
        expect(await countUploadSessions()).toBe(1);
    });

    test("an uploading session older than staleUploadSeconds is cleaned up", async () => {
        await insertUser();
        await insertUploadSession("sess-stale", "user-1", "uploading", nowSec() - 7200);

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 3600 });

        expect(result.uploadSessions).toBe(1);
    });

    test("an uploading session within staleUploadSeconds is NOT cleaned up", async () => {
        await insertUser();
        await insertUploadSession("sess-active", "user-1", "uploading", nowSec() - 60);

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 3600 });

        expect(result.uploadSessions).toBe(0);
        expect(await countUploadSessions()).toBe(1);
    });

    test("bytesReclaimed matches the total_size of an aborted session (an ops metric; the quota was already freed on abort)", async () => {
        // The quota is reserved on open and freed on abort. GC deletes the row and the
        // S3 objects and counts
        // bytesReclaimed, but it does NOT touch storage_used_files again.
        await insertUser();
        await insertUploadSession("sess-1", "user-1", "aborted", nowSec() - 1000, 3072);
        await insertFileChunk("sess-1", 0, "user-1", 1024);
        await insertFileChunk("sess-1", 1, "user-1", 2048);

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 3600 });

        expect(result.bytesReclaimed).toBe(3072);
        expect(await countFileChunks("sess-1")).toBe(0);
    });

    test("GC after an abort does not reduce storage_used_files (the abort already freed the quota)", async () => {
        await insertUser();
        // Simulate the state after abortTxn: the quota is already 0, the session aborted with a total_size.
        await setUserStorage("user-1@test.com", 10_000_000, 0);
        await insertUploadSession("sess-1", "user-1", "aborted", nowSec() - 1000, 5000);

        await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 3600 });

        // GREATEST(0, 0-5000) would leave 0, but a double free would show if used=5000 → 0.
        // Here used=0: a double free would stay 0, so we set used as if the abort had NOT freed
        // and we expect GC to leave it alone (it stays 5000) — a more realistic abort+GC scenario below.
        expect(await getUserStorageUsed("user-1@test.com")).toBe(0);
        expect(await countUploadSessions()).toBe(0);
    });

    test("abort-then-GC does not double-free while used still includes the reservation (regression)", async () => {
        // Worst case: the bug freed on both the abort AND the GC. If the abort path forgets to free,
        // GC still frees a stale uploading session. For an aborted one: used has to stay untouched.
        await insertUser();
        await setUserStorage("user-1@test.com", 10_000_000, 8000);
        await insertUploadSession(
            "sess-aborted",
            "user-1",
            "aborted",
            nowSec() - FILE_LIMITS.PRESIGNED_PUT_EXPIRES_SEC - 10,
            3000,
        );

        await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 3600 });

        expect(await getUserStorageUsed("user-1@test.com")).toBe(8000);
        expect(await countUploadSessions()).toBe(0);
    });

    test("a stale uploading session still frees the quota during GC", async () => {
        await insertUser();
        await setUserStorage("user-1@test.com", 10_000_000, 4000);
        await insertUploadSession("sess-stale", "user-1", "uploading", nowSec() - 7200, 1500);

        await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 3600 });

        expect(await getUserStorageUsed("user-1@test.com")).toBe(2500);
        expect(await countUploadSessions()).toBe(0);
    });

    test("an uploading session pinged after the candidate select is not deleted", async () => {
        await insertUser();
        await setUserStorage("user-1@test.com", 10_000_000, 4000);
        const now = nowSec();
        await insertUploadSession("sess-race", "user-1", "uploading", now - 7200, 1500);

        const orig = db.transaction.bind(db);
        const spy = spyOn(db, "transaction").mockImplementation((async (fn: unknown) => {
            await db
                .update(uploadSessions)
                .set({ updated_at: now })
                .where(eq(uploadSessions.id, "sess-race"));
            spy.mockRestore();
            return orig(fn as Parameters<typeof orig>[0]);
        }) as typeof db.transaction);

        try {
            await runGc({ now, blobPurgeGrace: 0, staleUploadSeconds: 3600 });
        } finally {
            spy.mockRestore();
        }

        expect(await countUploadSessions()).toBe(1);
        expect(await getUserStorageUsed("user-1@test.com")).toBe(4000);
    });
});

describe("runGc — section C (the pending_delete sweeper)", () => {
    beforeEach(resetDb);

    test("a chunk set with no pending_delete_at is NOT cleaned up", async () => {
        await insertUser();
        await insertChunkSet("set-1", "user-1", { totalSize: 5000, pendingDeleteAt: null });

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 0 });

        expect(result.blobsPurged).toBe(0);
        expect(await countChunkSets()).toBe(1);
    });

    test("a chunk set whose pending_delete_at is inside the grace window is NOT cleaned up", async () => {
        await insertUser();
        await insertChunkSet("set-1", "user-1", {
            totalSize: 5000,
            pendingDeleteAt: nowSec() - 100, // 100s ago, grace = 3600s
        });

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 3600, staleUploadSeconds: 0 });

        expect(result.blobsPurged).toBe(0);
        expect(await countChunkSets()).toBe(1);
    });

    test("a chunk set whose pending_delete_at is past the grace window is cleaned up", async () => {
        await insertUser();
        await insertChunkSet("set-1", "user-1", {
            totalSize: 5000,
            pendingDeleteAt: nowSec() - 7200, // 2h ago, grace = 1h
        });

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 3600, staleUploadSeconds: 0 });

        expect(result.blobsPurged).toBe(1);
        expect(result.bytesReclaimed).toBe(5000);
        expect(await countChunkSets()).toBe(0);
    });

    test("a chunk set past the grace window also deletes its own file_chunks rows", async () => {
        // file_chunks has no FK or cascade to chunk_sets (deliberately) — without an explicit delete
        // these rows stay orphaned forever once the chunk_set row is gone.
        await insertUser();
        await insertChunkSet("set-1", "user-1", {
            totalSize: 5000,
            pendingDeleteAt: nowSec() - 7200,
        });
        await insertFileChunk("set-1", 0, "user-1", 2500);
        await insertFileChunk("set-1", 1, "user-1", 2500);

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 3600, staleUploadSeconds: 0 });

        expect(result.blobsPurged).toBe(1);
        expect(await countChunkSets()).toBe(0);
        expect(await countFileChunks("set-1")).toBe(0);
    });

    test("a chunk set with pending_delete_at = 0 (grace=0) is cleaned up immediately", async () => {
        await insertUser();
        await insertChunkSet("set-1", "user-1", {
            totalSize: 1234,
            pendingDeleteAt: nowSec() - 1,
        });

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 0, staleUploadSeconds: 0 });

        expect(result.blobsPurged).toBe(1);
        expect(await countChunkSets()).toBe(0);
    });

    test("several chunk sets: only those past the grace window are deleted", async () => {
        await insertUser();
        await insertChunkSet("set-old", "user-1", {
            totalSize: 1000,
            pendingDeleteAt: nowSec() - 7200, // past the grace window
        });
        await insertChunkSet("set-new", "user-1", {
            totalSize: 2000,
            pendingDeleteAt: nowSec() - 100, // inside the grace window
        });
        await insertChunkSet("set-active", "user-1", {
            totalSize: 3000,
            pendingDeleteAt: null, // not pending
        });

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 3600, staleUploadSeconds: 0 });

        expect(result.blobsPurged).toBe(1);
        expect(result.bytesReclaimed).toBe(1000);
        expect(await countChunkSets()).toBe(2);
    });

    test("bytesReclaimed includes the total_size of several deleted sets", async () => {
        await insertUser();
        await insertChunkSet("set-a", "user-1", {
            totalSize: 1000,
            pendingDeleteAt: nowSec() - 7200,
        });
        await insertChunkSet("set-b", "user-1", {
            totalSize: 2000,
            pendingDeleteAt: nowSec() - 7200,
        });

        const result = await runGc({ now: nowSec(), blobPurgeGrace: 3600, staleUploadSeconds: 0 });

        expect(result.blobsPurged).toBe(2);
        expect(result.bytesReclaimed).toBe(3000);
    });
});

// ── Section C.2: Trash grows without bound (trash retention) ──
describe("runGc — a swept blob flips its upload session to `purged` (resume safety)", () => {
    beforeEach(resetDb);

    const DAY = 24 * 3600;
    const now = 1_700_000_000;

    test("section C: the committed session of a swept chunk set becomes `purged`", async () => {
        await insertUser("user-purged");
        await insertUploadSession("cs-swept", "user-purged", "committed", now - 7200, 1000);
        await insertChunkSet("cs-swept", "user-purged", {
            totalSize: 1000,
            pendingDeleteAt: now - 7200,
        });

        const result = await runGc({ now, blobPurgeGrace: 3600, staleUploadSeconds: DAY });

        expect(result.blobsPurged).toBe(1);
        // A resuming client must not read `committed` for bytes that no longer exist.
        expect(await getUploadSessionStatus("cs-swept")).toBe("purged");
    });

    test("section B: a `purged` session older than the stale window is dropped without touching the quota", async () => {
        await insertUser("user-purged-old");
        await setUserStorage("user-purged-old@test.com", 10_000, 5000);
        await insertUploadSession("cs-old", "user-purged-old", "purged", now - 2 * DAY, 1000);

        const result = await runGc({ now, blobPurgeGrace: 0, staleUploadSeconds: DAY });

        expect(result.uploadSessions).toBe(1);
        expect(result.bytesReclaimed).toBe(0); // the sweep already counted them
        expect(await countUploadSessions()).toBe(0);
        expect(await getUserStorageUsed("user-purged-old@test.com")).toBe(5000);
    });

    test("section B: a fresh `purged` session is kept so a resuming client still sees the truth", async () => {
        await insertUser("user-purged-fresh");
        await insertUploadSession(
            "cs-fresh-purged",
            "user-purged-fresh",
            "purged",
            now - 3600,
            1000,
        );

        const result = await runGc({ now, blobPurgeGrace: 0, staleUploadSeconds: DAY });

        expect(result.uploadSessions).toBe(0);
        expect(await getUploadSessionStatus("cs-fresh-purged")).toBe("purged");
    });
});

describe("runGc — section C.1 (old orphan chunk sets)", () => {
    beforeEach(resetDb);

    const DAY = 24 * 3600;
    const now = 1_700_000_000;

    test("a fresh orphan (inside the age guard) stays active", async () => {
        await insertUser("user-orphan-fresh");
        await setUserStorage("user-orphan-fresh@test.com", 10_000, 1000);
        await insertChunkSet("cs-fresh", "user-orphan-fresh", {
            totalSize: 1000,
            createdAt: now - 3600,
        });

        const result = await runGc({
            now,
            blobPurgeGrace: 0,
            staleUploadSeconds: 0,
            orphanChunkSetMinAgeSeconds: DAY,
        });

        expect(result.orphanChunkSetsMarked).toBe(0);
        expect(await getChunkSetPendingDeleteAt("cs-fresh")).toBeNull();
        expect(await getUserStorageUsed("user-orphan-fresh@test.com")).toBe(1000);
    });

    test("an old orphan → pending_delete plus storage_used_files released", async () => {
        await insertUser("user-orphan-stale");
        await setUserStorage("user-orphan-stale@test.com", 10_000, 1000);
        await insertChunkSet("cs-stale", "user-orphan-stale", {
            totalSize: 1000,
            createdAt: now - DAY - 3600,
        });

        const result = await runGc({
            now,
            blobPurgeGrace: 0,
            staleUploadSeconds: 0,
            orphanChunkSetMinAgeSeconds: DAY,
        });

        expect(result.orphanChunkSetsMarked).toBe(1);
        expect(await getChunkSetPendingDeleteAt("cs-stale")).toBeGreaterThan(0);
        expect(await getUserStorageUsed("user-orphan-stale@test.com")).toBe(0);
    });

    test("a chunk set that has an item is left alone even when old", async () => {
        await insertUser("user-owned");
        await insertChunkSet("cs-owned", "user-owned", {
            createdAt: now - DAY - 3600,
        });
        await insertLiveItem("item-owned", "user-owned", "cs-owned");

        const result = await runGc({
            now,
            blobPurgeGrace: 0,
            staleUploadSeconds: 0,
            orphanChunkSetMinAgeSeconds: DAY,
        });

        expect(result.orphanChunkSetsMarked).toBe(0);
        expect(await getChunkSetPendingDeleteAt("cs-owned")).toBeNull();
    });

    test("another user's item referencing a chunk set does not prevent the orphan mark", async () => {
        await insertUser("user-a");
        await insertUser("user-b");
        await setUserStorage("user-a@test.com", 10_000, 1000);
        await insertChunkSet("cs-a", "user-a", {
            totalSize: 1000,
            createdAt: now - DAY - 3600,
        });
        await db.insert(items).values({
            id: "note-b",
            user_id: "user-b",
            type: "note",
            sort_order: "m",
            chunk_set_id: "cs-a",
            version: 1,
        });

        const result = await runGc({
            now,
            blobPurgeGrace: 0,
            staleUploadSeconds: 0,
            orphanChunkSetMinAgeSeconds: DAY,
        });

        expect(result.orphanChunkSetsMarked).toBe(1);
        expect(await getChunkSetPendingDeleteAt("cs-a")).not.toBeNull();
    });
});

describe("runGc — section C.2 (trash retention)", () => {
    beforeEach(resetDb);

    test("an item in Trash for longer than trashRetentionSeconds is auto-purged", async () => {
        await insertUser();
        await insertDeletedItem("trash-old", "user-1", null, nowSec() - 35 * 24 * 3600);

        const result = await runGc({
            now: nowSec(),
            blobPurgeGrace: 0,
            staleUploadSeconds: 0,
            trashRetentionSeconds: 30 * 24 * 3600,
        });

        expect(result.autoPurgedItems).toBe(1);
        // We expect it to be a tombstone by now (purged_at IS NOT NULL)
        const itemsList = await db
            .select({ id: items.id, purged_at: items.purged_at })
            .from(items)
            .where(eq(items.id, "trash-old"));
        expect(itemsList.length).toBe(1);
        expect(itemsList[0]?.purged_at).not.toBeNull();
    });

    test("a fresh item in Trash (within trashRetentionSeconds) is left alone", async () => {
        await insertUser();
        await insertDeletedItem("trash-fresh", "user-1", null, nowSec() - 5 * 24 * 3600);

        const result = await runGc({
            now: nowSec(),
            blobPurgeGrace: 0,
            staleUploadSeconds: 0,
            trashRetentionSeconds: 30 * 24 * 3600,
        });

        expect(result.autoPurgedItems).toBe(0);
        const itemsList = await db
            .select({ id: items.id, purged_at: items.purged_at })
            .from(items)
            .where(eq(items.id, "trash-fresh"));
        expect(itemsList.length).toBe(1);
        expect(itemsList[0]?.purged_at).toBeNull();
    });
});

// ── Sections D+E: the items tombstone sweep + sync_deleted_log retention ──

const GC_BASE = { blobPurgeGrace: 0, staleUploadSeconds: 0 };
const DAY = 24 * 3600;

describe("runGc — section D (the items tombstone sweep)", () => {
    beforeEach(resetDb);

    test("a tombstone older than tombstonePurgeSeconds is physically deleted", async () => {
        await insertUser();
        await insertTombstoneItem("item-old", "user-1", nowSec() - 31 * DAY);

        const result = await runGc({ now: nowSec(), ...GC_BASE, tombstonePurgeSeconds: 30 * DAY });

        expect(result.itemTombstones).toBe(1);
        expect(await countItemRows("item-old")).toBe(0);
    });

    test("a fresh tombstone is NOT deleted", async () => {
        await insertUser();
        await insertTombstoneItem("item-fresh", "user-1", nowSec() - 1 * DAY);

        const result = await runGc({ now: nowSec(), ...GC_BASE, tombstonePurgeSeconds: 30 * DAY });

        expect(result.itemTombstones).toBe(0);
        expect(await countItemRows("item-fresh")).toBe(1);
    });

    test("a TRASHED item (deleted_at without purged_at) is NEVER deleted by the sweep", async () => {
        await insertUser();
        await insertChunkSet("set-t", "user-1");
        await insertDeletedItem("item-trashed", "user-1", "set-t", nowSec() - 90 * DAY);

        const result = await runGc({ now: nowSec(), ...GC_BASE, tombstonePurgeSeconds: 30 * DAY });

        expect(result.itemTombstones).toBe(0);
        expect(await countItemRows("item-trashed")).toBe(1);
    });

    test("a tombstone with children is skipped (the FK CASCADE guard) while a child exists", async () => {
        await insertUser();
        // An old tombstone folder plus a live child referencing it as its parent
        await insertTombstoneItem("folder-tomb", "user-1", nowSec() - 60 * DAY, {
            type: "folder",
        });
        await insertTombstoneItem("child-live", "user-1", nowSec() - 1 * DAY, {
            parentId: "folder-tomb",
        });

        const result = await runGc({ now: nowSec(), ...GC_BASE, tombstonePurgeSeconds: 30 * DAY });

        // The parent is skipped (a child references it), and the child is too fresh for the sweep
        expect(result.itemTombstones).toBe(0);
        expect(await countItemRows("folder-tomb")).toBe(1);
        expect(await countItemRows("child-live")).toBe(1);
    });

    test("a live child keeps an old tombstone parent", async () => {
        await insertUser();
        await insertTombstoneItem("tomb-parent", "user-1", nowSec() - 60 * DAY, { type: "folder" });
        await db.insert(items).values({
            id: "live-child",
            user_id: "user-1",
            type: "note",
            parent_id: "tomb-parent",
            sort_order: "m",
            version: 1,
        });

        await runGc({ now: nowSec(), ...GC_BASE, tombstonePurgeSeconds: 30 * DAY });

        expect(await countItemRows("tomb-parent")).toBe(1);
        expect(await countItemRows("live-child")).toBe(1);
    });

    // Each guarded the other: a tombstone with a child is skipped, so two old tombstones whose
    // parents form a cycle were never deleted.
    test("old tombstones whose parents form a cycle are deleted", async () => {
        await insertUser();
        await insertTombstoneItem("cyc-a", "user-1", nowSec() - 60 * DAY, { type: "folder" });
        await insertTombstoneItem("cyc-b", "user-1", nowSec() - 60 * DAY, {
            type: "folder",
            parentId: "cyc-a",
        });
        await db.update(items).set({ parent_id: "cyc-b" }).where(eq(items.id, "cyc-a"));

        await runGc({ now: nowSec(), ...GC_BASE, tombstonePurgeSeconds: 30 * DAY });

        expect(await countItemRows("cyc-a")).toBe(0);
        expect(await countItemRows("cyc-b")).toBe(0);
    });

    // parent_id is ON DELETE CASCADE all the way down: deleting an old tombstone whose only child
    // is another old tombstone would take that child's live children with it.
    test("a live grandchild under two old tombstones survives", async () => {
        await insertUser();
        await insertTombstoneItem("tomb-top", "user-1", nowSec() - 60 * DAY, { type: "folder" });
        await insertTombstoneItem("tomb-mid", "user-1", nowSec() - 60 * DAY, {
            type: "folder",
            parentId: "tomb-top",
        });
        await db.insert(items).values({
            id: "live-grandchild",
            user_id: "user-1",
            type: "note",
            parent_id: "tomb-mid",
            sort_order: "m",
            version: 1,
        });

        await runGc({ now: nowSec(), ...GC_BASE, tombstonePurgeSeconds: 30 * DAY });

        expect(await countItemRows("live-grandchild")).toBe(1);
        expect(await countItemRows("tomb-mid")).toBe(1);
    });
});

describe("runGc — section E (sync_deleted_log retention)", () => {
    beforeEach(resetDb);

    test("a log entry older than the retention is deleted; a fresh one stays", async () => {
        await insertUser();
        await insertDeletedLogEntry("user-1", "item-ancient", nowSec() - 800 * DAY);
        await insertDeletedLogEntry("user-1", "item-recent", nowSec() - 10 * DAY);

        const result = await runGc({
            now: nowSec(),
            ...GC_BASE,
            deletedLogRetentionSeconds: 730 * DAY,
        });

        expect(result.deletedLogRows).toBe(1);
        expect(await countDeletedLogRows()).toBe(1);
    });
});

describe("runDeepRepair", () => {
    beforeEach(resetDb);

    test("S3 objects the DB does not know about → delete (orphans)", async () => {
        await s3.send(
            new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: "u/user-999/cs-999/chunk-0",
                Body: "test",
            }),
        );
        const result = await runDeepRepair({ now: nowSec() + 25 * 3600 });
        expect(result.orphanDirs).toBeGreaterThanOrEqual(1);

        // Check that it was deleted
        const res = await s3.send(
            new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: "u/user-999/cs-999/" }),
        );
        expect(res.Contents?.length || 0).toBe(0);
    });

    test("a DB chunk set with no objects in S3 is deleted (ghost rows)", async () => {
        await insertUser("user-ghost");
        await insertChunkSet("cs-ghost", "user-ghost", { totalSize: 100 });

        const result = await runDeepRepair();
        expect(result.ghostRows).toBe(1);
        expect(await countChunkSets()).toBe(0);
    });

    test("does not delete a recently created unknown S3 object (in-flight upload)", async () => {
        await s3.send(
            new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: "u/user-live/cs-live/chunk-0",
                Body: "fresh",
            }),
        );
        await runDeepRepair();
        const res = await s3.send(
            new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: "u/user-live/cs-live/" }),
        );
        expect(res.Contents?.length || 0).toBeGreaterThan(0);
    });

    test("a fresh committed orphan is not marked pending_delete", async () => {
        await insertUser("user-fresh-orphan");
        await insertChunkSet("cs-fresh-orphan", "user-fresh-orphan", {
            pendingDeleteAt: null,
            createdAt: nowSec(),
        });
        await s3.send(
            new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: "u/user-fresh-orphan/cs-fresh-orphan/chunk-0",
                Body: "test",
            }),
        );

        const result = await runDeepRepair();
        expect(result.committedOrphans).toBe(0);
        expect(await getChunkSetPendingDeleteAt("cs-fresh-orphan")).toBeNull();
    });

    test("a committed chunk set with no item gets a pending_delete_at", async () => {
        await insertUser("user-3");
        await insertChunkSet("cs-orphan", "user-3", {
            pendingDeleteAt: null,
            createdAt: nowSec() - 25 * 3600,
        });
        // The S3 object has to exist, otherwise the ghost sweep deletes it in the same pass!
        await s3.send(
            new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: "u/user-3/cs-orphan/chunk-0",
                Body: "test",
            }),
        );

        const result = await runDeepRepair();
        expect(result.committedOrphans).toBe(1);

        const pending = await getChunkSetPendingDeleteAt("cs-orphan");
        expect(pending).not.toBeNull();
    });

    test("reconciles storage_used_files against the real chunk_set total_size values", async () => {
        await insertUser("user-4");
        await setUserStorage("user-4@test.com", 5000, 9999); // a wrong `used`

        await insertChunkSet("cs-4a", "user-4", { totalSize: 1000 });
        await insertChunkSet("cs-4b", "user-4", { totalSize: 2000 });
        await insertLiveItem("item-a", "user-4", "cs-4a");
        await insertLiveItem("item-b", "user-4", "cs-4b");
        // S3 objects, so they are not treated as ghosts
        await s3.send(
            new PutObjectCommand({ Bucket: S3_BUCKET, Key: "u/user-4/cs-4a/chunk-0", Body: "a" }),
        );
        await s3.send(
            new PutObjectCommand({ Bucket: S3_BUCKET, Key: "u/user-4/cs-4b/chunk-0", Body: "b" }),
        );

        const result = await runDeepRepair();
        expect(result.usersReconciled).toBe(1);

        const used = await getUserStorageUsed("user-4@test.com");
        expect(used).toBe(3000);
    });
});
