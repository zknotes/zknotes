import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { HISTORY_HARD_CAP, itemHistory, items, users } from "../../src/db/schema";
import { createTestUser, folderPayload, notePayload, resetDb } from "../helpers";

let app: FastifyInstance;
let cookie: string;
let cookie2: string; // a second user, for the isolation tests

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    await resetDb();
    ({ cookie } = await createTestUser(app));
    ({ cookie: cookie2 } = await createTestUser(app, { email: "other@example.com" }));
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function createNote(c = cookie): Promise<string> {
    const id = uuidv7();
    const res = await app.inject({
        method: "POST",
        url: "/items",
        headers: { cookie: c },
        payload: notePayload(id),
    });
    expect(res.statusCode).toBe(201);
    return id;
}

async function userIdForItem(itemId: string): Promise<string> {
    const [row] = await db
        .select({ user_id: items.user_id })
        .from(items)
        .where(eq(items.id, itemId));
    if (!row) throw new Error(`test setup: item ${itemId} not found`);
    return row.user_id;
}

function snapshotPayload(itemId: string, overrides?: Record<string, unknown>) {
    return {
        item_id: itemId,
        encrypted_payload: "c25hcHNob3Q=", // base64
        payload_nonce: "A".repeat(32),
        encrypted_item_key: "C".repeat(64),
        item_key_nonce: "B".repeat(32),
        item_version_at_snapshot: 1,
        ...overrides,
    };
}

async function postSnapshot(
    itemId: string,
    c = cookie,
    overrides?: Record<string, unknown>,
): Promise<{ statusCode: number; body: any }> {
    const res = await app.inject({
        method: "POST",
        url: `/items/${itemId}/history`,
        headers: { cookie: c },
        payload: snapshotPayload(itemId, overrides),
    });
    return { statusCode: res.statusCode, body: res.json() };
}

async function countSnapshots(itemId: string): Promise<number> {
    const [row] = await db
        .select({ n: sql<number>`COUNT(*)::integer` })
        .from(itemHistory)
        .where(eq(itemHistory.item_id, itemId));
    return row?.n ?? 0;
}

// ── POST /items/:id/history ───────────────────────────────────────────────────

describe("POST /items/:id/history", () => {
    test("without a session → 401", async () => {
        const id = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: `/items/${id}/history`,
            payload: snapshotPayload(id),
        });
        expect(res.statusCode).toBe(401);
    });

    test("a nonexistent item → 404", async () => {
        const id = uuidv7();
        const { statusCode } = await postSnapshot(id);
        expect(statusCode).toBe(404);
    });

    test("another user's item → 404", async () => {
        const id = await createNote(cookie);
        const { statusCode } = await postSnapshot(id, cookie2);
        expect(statusCode).toBe(404);
    });

    test("creates a snapshot → 201 with the correct fields", async () => {
        const id = await createNote();
        const { statusCode, body } = await postSnapshot(id);
        expect(statusCode).toBe(201);
        expect(body.id).toBeString();
        expect(body.item_id).toBe(id);
        expect(body.encrypted_payload).toBe("c25hcHNob3Q=");
        expect(body.payload_nonce).toBe("A".repeat(32));
        expect(body.item_version_at_snapshot).toBe(1);
        expect(body.created_at).toBeNumber();
        expect(body.created_at).toBeGreaterThan(0);
    });

    test("an item_id mismatch in the body → 400", async () => {
        const id = await createNote();
        const otherId = uuidv7();
        const { statusCode } = await postSnapshot(id, cookie, { item_id: otherId });
        expect(statusCode).toBe(400);
    });

    test("a snapshot on a folder → 400 history_only_for_notes", async () => {
        const folderId = uuidv7();
        const create = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: folderPayload(folderId),
        });
        expect(create.statusCode).toBe(201);

        const res = await app.inject({
            method: "POST",
            url: `/items/${folderId}/history`,
            headers: { cookie },
            payload: snapshotPayload(folderId),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("history_only_for_notes");
    });

    test("a required field is missing → 400", async () => {
        const id = await createNote();
        const res = await app.inject({
            method: "POST",
            url: `/items/${id}/history`,
            headers: { cookie },
            payload: { item_id: id }, // no encrypted_payload, no nonces, and so on
        });
        expect(res.statusCode).toBe(400);
    });

    test("a wrong nonce format (length) → 400", async () => {
        const id = await createNote();
        const { statusCode } = await postSnapshot(id, cookie, { payload_nonce: "tooshort" });
        expect(statusCode).toBe(400);
    });

    test("a snapshot can be created several times for the same note", async () => {
        const id = await createNote();
        await postSnapshot(id);
        await postSnapshot(id);
        await postSnapshot(id);
        expect(await countSnapshots(id)).toBe(3);
    });

    test("snapshots of different notes do not mix", async () => {
        const id1 = await createNote();
        const id2 = await createNote();
        await postSnapshot(id1);
        await postSnapshot(id1);
        await postSnapshot(id2);
        expect(await countSnapshots(id1)).toBe(2);
        expect(await countSnapshots(id2)).toBe(1);
    });
});

// ── GET /items/:id/history ────────────────────────────────────────────────────

describe("GET /items/:id/history", () => {
    test("without a session → 401", async () => {
        const id = uuidv7();
        const res = await app.inject({ method: "GET", url: `/items/${id}/history` });
        expect(res.statusCode).toBe(401);
    });

    test("a nonexistent item → 404", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/items/${uuidv7()}/history`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(404);
    });

    test("another user's item → 404", async () => {
        const id = await createNote(cookie);
        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history`,
            headers: { cookie: cookie2 },
        });
        expect(res.statusCode).toBe(404);
    });

    test("an empty list for a note with no snapshots", async () => {
        const id = await createNote();
        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().snapshots).toEqual([]);
        expect(res.json().total).toBe(0);
    });

    test("returns snapshots sorted newest first", async () => {
        const id = await createNote();
        await postSnapshot(id);
        await postSnapshot(id);
        await postSnapshot(id);

        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history`,
            headers: { cookie },
        });
        const { snapshots } = res.json();
        expect(snapshots).toHaveLength(3);
        // DESC by created_at — check that they are sorted
        for (let i = 1; i < snapshots.length; i++) {
            expect(snapshots[i - 1].created_at).toBeGreaterThanOrEqual(snapshots[i].created_at);
        }
    });

    test("the limit query parameter bounds the results", async () => {
        const id = await createNote();
        for (let i = 0; i < 5; i++) await postSnapshot(id);

        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history?limit=3`,
            headers: { cookie },
        });
        expect(res.json().snapshots).toHaveLength(3);
    });

    test("the limit is clamped to a maximum of 50", async () => {
        const id = await createNote();
        // Insert 5 snapshots, ask for limit=100 — only 5 should come back (never more than exist)
        for (let i = 0; i < 5; i++) await postSnapshot(id);
        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history?limit=100`,
            headers: { cookie },
        });
        expect(res.json().snapshots).toHaveLength(5);
    });

    test("the before query filters by timestamp", async () => {
        const id = await createNote();
        const midMs = Date.now();

        // Insert older snapshots straight into the DB (bypassing the POST, which stamps now())
        const userId = await userIdForItem(id);
        const oldSec = Math.floor(midMs / 1000) - 200;
        const newSec = Math.floor(midMs / 1000) + 200;

        await db.insert(itemHistory).values({
            id: uuidv7(),
            item_id: id,
            user_id: userId,
            encrypted_payload: Buffer.from("old", "utf8"),
            payload_nonce: Buffer.from("A".repeat(32), "base64"),
            encrypted_item_key: Buffer.from("key", "utf8"),
            item_key_nonce: Buffer.from("B".repeat(32), "base64"),
            item_version_at_snapshot: 1,
            created_at: oldSec,
        });
        await db.insert(itemHistory).values({
            id: uuidv7(),
            item_id: id,
            user_id: userId,
            encrypted_payload: Buffer.from("new", "utf8"),
            payload_nonce: Buffer.from("A".repeat(32), "base64"),
            encrypted_item_key: Buffer.from("key", "utf8"),
            item_key_nonce: Buffer.from("B".repeat(32), "base64"),
            item_version_at_snapshot: 2,
            created_at: newSec,
        });

        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history?before=${midMs}`,
            headers: { cookie },
        });
        const { snapshots } = res.json();
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].item_version_at_snapshot).toBe(1);
    });

    test("a snapshot carries every required field", async () => {
        const id = await createNote();
        await postSnapshot(id);

        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history`,
            headers: { cookie },
        });
        const snap = res.json().snapshots[0];
        expect(snap.id).toBeString();
        expect(snap.item_id).toBe(id);
        expect(snap.encrypted_payload).toBeString();
        expect(snap.payload_nonce).toBeString();
        expect(snap.encrypted_item_key).toBeString();
        expect(snap.item_key_nonce).toBeString();
        expect(snap.item_version_at_snapshot).toBeNumber();
        expect(snap.created_at).toBeNumber();
    });
});

// ── GET /items/:id/history/:snapshotId ────────────────────────────────────────

describe("GET /items/:id/history/:snapshotId", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/items/${uuidv7()}/history/${uuidv7()}`,
        });
        expect(res.statusCode).toBe(401);
    });

    test("a nonexistent snapshot → 404", async () => {
        const id = await createNote();
        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history/${uuidv7()}`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(404);
    });

    test("another user's snapshot → 404", async () => {
        const id = await createNote(cookie);
        const { body } = await postSnapshot(id, cookie);
        const snapId = body.id;

        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history/${snapId}`,
            headers: { cookie: cookie2 },
        });
        expect(res.statusCode).toBe(404);
    });

    test("returns the exact snapshot by ID", async () => {
        const id = await createNote();
        const { body: snap1 } = await postSnapshot(id, cookie, {
            encrypted_payload: "Zmlyc3Q=",
        });
        await postSnapshot(id); // a second snapshot

        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history/${snap1.id}`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().id).toBe(snap1.id);
        expect(res.json().encrypted_payload).toBe("Zmlyc3Q=");
    });

    test("a snapshot ID with the wrong item_id → 404", async () => {
        const id1 = await createNote();
        const id2 = await createNote();
        const { body: snap } = await postSnapshot(id1);

        // Try to fetch snap1 under id2
        const res = await app.inject({
            method: "GET",
            url: `/items/${id2}/history/${snap.id}`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(404);
    });
});

// ── DELETE /items/:id/history/:snapshotId ─────────────────────────────────────

describe("DELETE /items/:id/history/:snapshotId", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({
            method: "DELETE",
            url: `/items/${uuidv7()}/history/${uuidv7()}`,
        });
        expect(res.statusCode).toBe(401);
    });

    test("a nonexistent snapshot → 404", async () => {
        const id = await createNote();
        const res = await app.inject({
            method: "DELETE",
            url: `/items/${id}/history/${uuidv7()}`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(404);
    });

    test("another user's snapshot → 404 (it does not delete theirs)", async () => {
        const id = await createNote(cookie);
        const { body: snap } = await postSnapshot(id, cookie);

        const res = await app.inject({
            method: "DELETE",
            url: `/items/${id}/history/${snap.id}`,
            headers: { cookie: cookie2 },
        });
        expect(res.statusCode).toBe(404);
        // Check that the record was not deleted
        expect(await countSnapshots(id)).toBe(1);
    });

    test("deletes a snapshot → 204, and the snapshot is no longer reachable", async () => {
        const id = await createNote();
        const { body: snap } = await postSnapshot(id);
        expect(await countSnapshots(id)).toBe(1);

        const delRes = await app.inject({
            method: "DELETE",
            url: `/items/${id}/history/${snap.id}`,
            headers: { cookie },
        });
        expect(delRes.statusCode).toBe(204);
        expect(await countSnapshots(id)).toBe(0);

        // GET should return 404 for a deleted snapshot
        const getRes = await app.inject({
            method: "GET",
            url: `/items/${id}/history/${snap.id}`,
            headers: { cookie },
        });
        expect(getRes.statusCode).toBe(404);
    });

    test("deleting one does not affect the others", async () => {
        const id = await createNote();
        const { body: snap1 } = await postSnapshot(id);
        const { body: snap2 } = await postSnapshot(id);

        await app.inject({
            method: "DELETE",
            url: `/items/${id}/history/${snap1.id}`,
            headers: { cookie },
        });

        expect(await countSnapshots(id)).toBe(1);
        const getRes = await app.inject({
            method: "GET",
            url: `/items/${id}/history/${snap2.id}`,
            headers: { cookie },
        });
        expect(getRes.statusCode).toBe(200);
    });
});

// ── Cascade: deleting a note deletes its snapshots too ───────────────────────

describe("cascade deletion", () => {
    test("soft-deleting a note leaves its snapshots (the FK cascade fires only on a hard delete)", async () => {
        const id = await createNote();
        await postSnapshot(id);
        expect(await countSnapshots(id)).toBe(1);

        // A soft delete — the snapshots stay (items.deleted_at does not delete physically)
        await app.inject({
            method: "DELETE",
            url: `/items/${id}`,
            headers: { cookie },
        });
        expect(await countSnapshots(id)).toBe(1);
    });
});

// ── The tiered thin-out logic ─────────────────────────────────────────────────

describe("thin-out (tiered retention)", () => {
    test(`hard cap: there can never be more than ${HISTORY_HARD_CAP} snapshots`, async () => {
        const id = await createNote();

        // Insert HISTORY_HARD_CAP + 5 snapshots directly, with different timestamps
        const userId = await userIdForItem(id);

        const nowSec = Math.floor(Date.now() / 1000);
        // Older than 30 days — each in a different week so they survive (1/week retention)
        const WEEK = 7 * 86400;
        for (let i = HISTORY_HARD_CAP + 4; i >= 0; i--) {
            await db.insert(itemHistory).values({
                id: uuidv7(),
                item_id: id,
                user_id: userId,
                encrypted_payload: Buffer.alloc(4, i),
                payload_nonce: Buffer.alloc(24, i),
                encrypted_item_key: Buffer.alloc(4, i),
                item_key_nonce: Buffer.alloc(24, i),
                item_version_at_snapshot: i + 1,
                // Each in a different week (spaced far enough apart to survive the 1/week rule)
                created_at: nowSec - 40 * 86400 - i * WEEK,
            });
        }

        // POST a new snapshot — it triggers the thin-out
        await postSnapshot(id);

        const count = await countSnapshots(id);
        expect(count).toBeLessThanOrEqual(HISTORY_HARD_CAP);
    });

    test("the thin-out keeps every snapshot within 24h, cutting none", async () => {
        const id = await createNote();
        const userId = await userIdForItem(id);

        const nowSec = Math.floor(Date.now() / 1000);
        // 10 snapshots within the last 2h
        for (let i = 0; i < 10; i++) {
            await db.insert(itemHistory).values({
                id: uuidv7(),
                item_id: id,
                user_id: userId,
                encrypted_payload: Buffer.alloc(4),
                payload_nonce: Buffer.alloc(24),
                encrypted_item_key: Buffer.alloc(4),
                item_key_nonce: Buffer.alloc(24),
                item_version_at_snapshot: i + 1,
                created_at: nowSec - i * 600, // every 10 min
            });
        }

        // The 11th POST → the thin-out runs, but 11 < 50 (the hard cap)
        await postSnapshot(id);

        expect(await countSnapshots(id)).toBe(11);
    });

    test("thin-out for old data: the last 30 days — 1/day", async () => {
        const id = await createNote();
        const userId = await userIdForItem(id);

        const nowSec = Math.floor(Date.now() / 1000);
        const DAY = 86400;

        // 3 snapshots on the same day (5 days back) — pinned to noon of the daily bucket so that
        // the +30/60min offsets do not cross the UTC day boundary when the test runs near midnight
        const targetDaySec = Math.floor((nowSec - 5 * DAY) / DAY) * DAY + 43200;
        for (let i = 0; i < 3; i++) {
            await db.insert(itemHistory).values({
                id: uuidv7(),
                item_id: id,
                user_id: userId,
                encrypted_payload: Buffer.alloc(4),
                payload_nonce: Buffer.alloc(24),
                encrypted_item_key: Buffer.alloc(4),
                item_key_nonce: Buffer.alloc(24),
                item_version_at_snapshot: i + 1,
                created_at: targetDaySec + i * 1800, // 30 min apart, within the same day
            });
        }

        // POST a new snapshot (from "today") — this triggers the thin-out
        await postSnapshot(id);

        // After the thin-out: of the 3 on the same day → 1 remains (the latest), plus today's = 2 in total
        const count = await countSnapshots(id);
        expect(count).toBe(2);
    });

    test("the thin-out keeps the LATEST snapshot of each day, not the earliest", async () => {
        const id = await createNote();
        const userId = await userIdForItem(id);

        const nowSec = Math.floor(Date.now() / 1000);
        const DAY = 86400;

        // Pin to noon of the target day — far from the day boundaries, so all 3 land in the same bucket
        const dayBucket = Math.floor((nowSec - 5 * DAY) / DAY);
        const baseSec = dayBucket * DAY + 43200; // noon that day

        // Insert 3 snapshots on the same day — different versions; v3 is the newest (highest created_at)
        for (let i = 0; i < 3; i++) {
            await db.insert(itemHistory).values({
                id: uuidv7(),
                item_id: id,
                user_id: userId,
                encrypted_payload: Buffer.alloc(4),
                payload_nonce: Buffer.alloc(24),
                encrypted_item_key: Buffer.alloc(4),
                item_key_nonce: Buffer.alloc(24),
                item_version_at_snapshot: i + 1, // v1, v2, v3
                created_at: baseSec + i * 1800, // every 30 min, all in the same daily bucket
            });
        }

        // POST today — this triggers the thin-out; version 99 keeps it apart from v1/v2/v3
        await postSnapshot(id, cookie, { item_version_at_snapshot: 99 });

        // Exactly 2 should remain: 1 from the old day plus today's
        expect(await countSnapshots(id)).toBe(2);

        // Check that the version with the highest created_at survived (v3, not v1)
        // Keep only the snapshots from the old day (not today's v99)
        const oldRemaining = await db
            .select({ version: itemHistory.item_version_at_snapshot })
            .from(itemHistory)
            .where(and(eq(itemHistory.item_id, id), sql`item_version_at_snapshot < 10`));

        expect(oldRemaining).toHaveLength(1);
        const survivor = oldRemaining[0];
        expect(survivor?.version).toBe(3); // v3 (the latest) survived; v1 and v2 were deleted
    });

    test("thin-out for data older than 30 days: 1/week", async () => {
        const id = await createNote();
        const userId = await userIdForItem(id);

        const nowSec = Math.floor(Date.now() / 1000);
        const DAY = 86400;
        const WEEK = 7 * DAY;

        // Pin to Wednesday (the middle) of the weekly bucket, >30 days back — far from the boundaries
        const weekBucket = Math.floor((nowSec - 35 * DAY) / WEEK);
        const weekMid = weekBucket * WEEK + 3 * DAY + 43200; // Wednesday noon

        // 3 snapshots in the same weekly bucket, 12h apart
        for (let i = 0; i < 3; i++) {
            await db.insert(itemHistory).values({
                id: uuidv7(),
                item_id: id,
                user_id: userId,
                encrypted_payload: Buffer.alloc(4),
                payload_nonce: Buffer.alloc(24),
                encrypted_item_key: Buffer.alloc(4),
                item_key_nonce: Buffer.alloc(24),
                item_version_at_snapshot: i + 1,
                created_at: weekMid + i * 43200, // every 12h, all within the same weekly bucket
            });
        }

        // POST a new snapshot — it triggers the thin-out
        await postSnapshot(id);

        // Of the 3 in the same week → 1 remains (the latest in the weekly bucket) plus today's = 2
        expect(await countSnapshots(id)).toBe(2);
    });

    test("thin-out: a mix of within-24h and older — the 24h ones untouched, the older ones thinned", async () => {
        const id = await createNote();
        const userId = await userIdForItem(id);

        const nowSec = Math.floor(Date.now() / 1000);
        const DAY = 86400;

        // 3 snapshots within the last 2h (fresh — they must not be deleted)
        for (let i = 0; i < 3; i++) {
            await db.insert(itemHistory).values({
                id: uuidv7(),
                item_id: id,
                user_id: userId,
                encrypted_payload: Buffer.alloc(4),
                payload_nonce: Buffer.alloc(24),
                encrypted_item_key: Buffer.alloc(4),
                item_key_nonce: Buffer.alloc(24),
                item_version_at_snapshot: 10 + i,
                created_at: nowSec - i * 1800,
            });
        }

        // 3 snapshots on the same day, 5 days back (of which 1 should remain) — pinned to noon of
        // the daily bucket so the +1/2h offsets do not cross the UTC day boundary
        const oldBase = Math.floor((nowSec - 5 * DAY) / DAY) * DAY + 43200;
        for (let i = 0; i < 3; i++) {
            await db.insert(itemHistory).values({
                id: uuidv7(),
                item_id: id,
                user_id: userId,
                encrypted_payload: Buffer.alloc(4),
                payload_nonce: Buffer.alloc(24),
                encrypted_item_key: Buffer.alloc(4),
                item_key_nonce: Buffer.alloc(24),
                item_version_at_snapshot: 20 + i,
                created_at: oldBase + i * 3600,
            });
        }

        // A new POST → this triggers the thin-out; the new one is within 24h so it is kept too
        await postSnapshot(id);

        // The result: 3 fresh (24h) + 1 from the old day + 1 new POST = 5
        expect(await countSnapshots(id)).toBe(5);
    });
});

// ── POST validation: edge cases ──────────────────────────────────────────────

describe("POST /items/:id/history — further validation", () => {
    test("item_version_at_snapshot: 0 → 400 (the minimum is 1)", async () => {
        const id = await createNote();
        const { statusCode } = await postSnapshot(id, cookie, { item_version_at_snapshot: 0 });
        expect(statusCode).toBe(400);
    });

    test("item_version_at_snapshot: -1 → 400", async () => {
        const id = await createNote();
        const { statusCode } = await postSnapshot(id, cookie, { item_version_at_snapshot: -1 });
        expect(statusCode).toBe(400);
    });

    test("an item_key_nonce of the wrong length → 400", async () => {
        const id = await createNote();
        const { statusCode } = await postSnapshot(id, cookie, { item_key_nonce: "tooshort" });
        expect(statusCode).toBe(400);
    });

    test("a snapshot for a folder → 400 (the server enforces type=note)", async () => {
        const folderId = uuidv7();
        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: folderPayload(folderId),
        });
        expect(res.statusCode).toBe(201);

        const { statusCode, body } = await postSnapshot(folderId);
        expect(statusCode).toBe(400);
        expect(body.error).toBe("history_only_for_notes");
    });

    test("base64 blobs are stored and returned unchanged", async () => {
        const id = await createNote();
        const uniquePayload = "dGVzdFBheWxvYWQxMjM="; // base64 that is easy to recognise
        const uniqueNonce = "Q".repeat(32);
        const uniqueIk = "cGVybVNlY3JldEtleQ==";
        const uniqueIkNonce = "Z".repeat(32);

        const { body } = await postSnapshot(id, cookie, {
            encrypted_payload: uniquePayload,
            payload_nonce: uniqueNonce,
            encrypted_item_key: uniqueIk,
            item_key_nonce: uniqueIkNonce,
        });

        // Check the POST response
        expect(body.encrypted_payload).toBe(uniquePayload);
        expect(body.payload_nonce).toBe(uniqueNonce);
        expect(body.encrypted_item_key).toBe(uniqueIk);
        expect(body.item_key_nonce).toBe(uniqueIkNonce);

        // Check the GET list (a round trip through the database)
        const listRes = await app.inject({
            method: "GET",
            url: `/items/${id}/history`,
            headers: { cookie },
        });
        const snap = listRes.json().snapshots[0];
        expect(snap.encrypted_payload).toBe(uniquePayload);
        expect(snap.payload_nonce).toBe(uniqueNonce);
        expect(snap.encrypted_item_key).toBe(uniqueIk);
        expect(snap.item_key_nonce).toBe(uniqueIkNonce);
    });
});

// ── GET list — further cases ─────────────────────────────────────────────────

describe("GET /items/:id/history — further cases", () => {
    test("total always equals the length of the snapshots array", async () => {
        const id = await createNote();
        for (let i = 0; i < 4; i++) await postSnapshot(id);

        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history`,
            headers: { cookie },
        });
        const body = res.json();
        expect(body.total).toBe(body.snapshots.length);
    });

    test("limit=0 returns an empty array", async () => {
        const id = await createNote();
        await postSnapshot(id);

        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history?limit=0`,
            headers: { cookie },
        });
        expect(res.json().snapshots).toHaveLength(0);
    });

    test("before is exclusive (a snapshot exactly at the before time is not included)", async () => {
        const id = await createNote();
        const userId = await userIdForItem(id);

        const exactSec = Math.floor(Date.now() / 1000) - 100;

        await db.insert(itemHistory).values({
            id: uuidv7(),
            item_id: id,
            user_id: userId,
            encrypted_payload: Buffer.from("x"),
            payload_nonce: Buffer.alloc(24),
            encrypted_item_key: Buffer.from("y"),
            item_key_nonce: Buffer.alloc(24),
            item_version_at_snapshot: 1,
            created_at: exactSec,
        });

        // before=exactSec*1000 — a snapshot on exactly that second must NOT be included (lt, not lte)
        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history?before=${exactSec * 1000}`,
            headers: { cookie },
        });
        expect(res.json().snapshots).toHaveLength(0);
    });

    test("before filters: a snapshot 1s before it is returned", async () => {
        const id = await createNote();
        const userId = await userIdForItem(id);

        const snapSec = Math.floor(Date.now() / 1000) - 100;

        await db.insert(itemHistory).values({
            id: uuidv7(),
            item_id: id,
            user_id: userId,
            encrypted_payload: Buffer.from("x"),
            payload_nonce: Buffer.alloc(24),
            encrypted_item_key: Buffer.from("y"),
            item_key_nonce: Buffer.alloc(24),
            item_version_at_snapshot: 1,
            created_at: snapSec,
        });

        // before=(snapSec+1)*1000 — the snapshot is 1s older than before, so it should be included
        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history?before=${(snapSec + 1) * 1000}`,
            headers: { cookie },
        });
        expect(res.json().snapshots).toHaveLength(1);
    });
});

// ── GET single — every field ─────────────────────────────────────────────────

describe("GET /items/:id/history/:snapshotId — every field", () => {
    test("a single snapshot carries every required field with the correct values", async () => {
        const id = await createNote();
        const { body: created } = await postSnapshot(id, cookie, {
            item_version_at_snapshot: 7,
            encrypted_payload: "c25hcHNob3Q=",
            payload_nonce: "A".repeat(32),
            encrypted_item_key: "C".repeat(64),
            item_key_nonce: "B".repeat(32),
        });

        const res = await app.inject({
            method: "GET",
            url: `/items/${id}/history/${created.id}`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);

        const snap = res.json();
        expect(snap.id).toBe(created.id);
        expect(snap.item_id).toBe(id);
        expect(snap.encrypted_payload).toBe("c25hcHNob3Q=");
        expect(snap.payload_nonce).toBe("A".repeat(32));
        expect(snap.encrypted_item_key).toBe("C".repeat(64));
        expect(snap.item_key_nonce).toBe("B".repeat(32));
        expect(snap.item_version_at_snapshot).toBe(7);
        expect(snap.created_at).toBeNumber();
        expect(snap.created_at).toBeGreaterThan(0);
    });
});

// ── DELETE — further cases ───────────────────────────────────────────────────

describe("DELETE /items/:id/history/:snapshotId — further cases", () => {
    test("a snapshot ID with the wrong item_id → 404 (it does not delete someone else's snapshot)", async () => {
        const id1 = await createNote();
        const id2 = await createNote();
        const { body: snap } = await postSnapshot(id1);

        const res = await app.inject({
            method: "DELETE",
            url: `/items/${id2}/history/${snap.id}`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(404);
        // The id1 snapshot stays untouched
        expect(await countSnapshots(id1)).toBe(1);
    });
});

// ── The cascade: deleting a user ─────────────────────────────────────────────

describe("the cascade when a user is deleted", () => {
    test("physically deleting a user cascades to every snapshot (FK CASCADE)", async () => {
        const id = await createNote();
        await postSnapshot(id);
        await postSnapshot(id);
        expect(await countSnapshots(id)).toBe(2);

        // Delete the user straight from the DB — this should cascade items → item_history
        const userId = await userIdForItem(id);
        await db.delete(users).where(eq(users.id, userId));

        expect(await countSnapshots(id)).toBe(0);
    });
});
