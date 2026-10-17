import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { db } from "../src/db";
import { flushPendingSecurityEvents } from "../src/events";
import {
    chunkSets,
    fileChunks,
    items,
    syncDeletedLog,
    uploadSessions,
    users,
} from "../src/db/schema.ts";

export { db };

/** Deletes every row from every table. chunk_sets and file_chunks have no FK to users, so they have
 *  to be listed explicitly. CASCADE sorts out the order for the rest. */
export async function resetDb(): Promise<void> {
    // Security events write in the background. The `TRUNCATE` below takes an
    // AccessExclusiveLock and can **deadlock** against such a write holding an AccessShareLock — seen
    // in practice. Waiting here also covers tests that sign in outside `createTestUser`.
    await flushPendingSecurityEvents();
    await db.execute(
        sql`TRUNCATE TABLE gc_runs, analytics_daily_active_users, analytics_active_users_daily, analytics_route_daily, analytics_auth_daily, analytics_storage_quota_daily, share_attachments, share_links, restore_staged_items, restore_sessions, chunk_sets, file_chunks, upload_sessions, sync_deleted_log, items, sessions, login_failures, users CASCADE`,
    );
}

/**
 * Creates a user and signs them in; returns the session cookie plus the credentials.
 *
 * Open-core has no account layer, so it takes the **core's** path: `POST /vault` with no pass, which
 * is the first registration for a self-host. That is why the tests need
 * `SELF_HOST_REGISTRATION_OPEN=true` — otherwise the core closes registration after the first user
 * and every subsequent `createTestUser` gets a `403 registration_closed`.
 */
export async function createTestUser(
    app: FastifyInstance,
    overrides?: { email?: string; auth_key?: string },
): Promise<{ cookie: string; email: string; auth_key: string }> {
    const email = overrides?.email ?? "test@example.com";
    const auth_key = overrides?.auth_key ?? "A".repeat(44);

    const created = await app.inject({
        method: "POST",
        url: "/vault",
        payload: {
            email,
            auth_key,
            kdf_salt: "B".repeat(24),
            kdf_params: { m: 1024, t: 1, p: 1 },
            encrypted_vault_key: "A".repeat(64),
            vault_key_nonce: "B".repeat(32),
        },
    });
    if (created.statusCode !== 201) {
        throw new Error(
            `createTestUser vault create failed (${created.statusCode}): ${created.body}`,
        );
    }

    const login = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, auth_key },
    });
    if (login.statusCode !== 200) {
        throw new Error(`createTestUser login failed (${login.statusCode}): ${login.body}`);
    }

    // Signing in emits a security event; the core only emits it (there is no subscriber without
    // an extension), but we still wait so it does not race the next test's `resetDb()`.
    await app.flushSecurityEvents();

    const setCookie = login.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const sessionToken = cookieStr?.match(/session_token=([^;]+)/)?.[1];
    if (!sessionToken) throw new Error("No session_token cookie in login response");

    return { cookie: `session_token=${sessionToken}`, email, auth_key };
}

/** Creates a note item payload with the minimum fields needed. */
export function notePayload(id: string, overrides?: Record<string, unknown>) {
    return {
        id,
        type: "note",
        parent_id: null,
        encrypted_payload: "cGF5bG9hZA==",
        payload_nonce: "A".repeat(32),
        encrypted_item_key: "C".repeat(64),
        item_key_nonce: "B".repeat(32),
        sort_order: "m",
        version: 1,
        ...overrides,
    };
}

/** Builds a file item payload referencing a chunk_set_id. */
export function filePayload(id: string, chunkSetId: string, overrides?: Record<string, unknown>) {
    return {
        id,
        type: "file",
        parent_id: null,
        encrypted_payload: "ZmlsZXBheWxvYWQ=",
        payload_nonce: "E".repeat(32),
        encrypted_item_key: "C".repeat(64),
        item_key_nonce: "F".repeat(32),
        sort_order: "m",
        version: 1,
        chunk_set_id: chunkSetId,
        chunk_count: 1,
        ciphertext_size: 19,
        ...overrides,
    };
}

/** Creates a folder item payload. */
export function folderPayload(
    id: string,
    parent_id: string | null = null,
    overrides?: Record<string, unknown>,
) {
    return {
        id,
        type: "folder",
        parent_id,
        encrypted_payload: "Zm9sZGVy",
        payload_nonce: "C".repeat(32),
        encrypted_item_key: "C".repeat(64),
        item_key_nonce: "D".repeat(32),
        sort_order: "m",
        version: 1,
        ...overrides,
    };
}

/**
 * Seeds a committed chunk set straight into the database, then creates a file item referencing it.
 * The upload flow (a presigned PUT to S3) is not what the tests using this are about — those paths
 * touch Postgres only, so DB seeding is both sufficient and accurate. storage_used_files is raised
 * as if the upload had reserved the quota (open-upload semantics).
 * The real presigned PUT → finalize path is covered by the tests in test/routes/files.test.ts.
 */
export async function createSeededFileItem(
    app: FastifyInstance,
    cookie: string,
    email: string,
    fileSize: number,
): Promise<{ itemId: string; chunkSetId: string }> {
    const userId = await getUserIdByEmail(email);
    if (!userId) throw new Error(`createSeededFileItem: unknown user ${email}`);

    const chunkSetId = uuidv7();
    await insertChunkSet(chunkSetId, userId, { totalSize: fileSize });
    await db
        .update(users)
        .set({ storage_used_files: sql`storage_used_files + ${fileSize}` })
        .where(eq(users.email, email));

    const itemId = uuidv7();
    const res = await app.inject({
        method: "POST",
        url: "/items",
        headers: { cookie },
        payload: filePayload(itemId, chunkSetId),
    });
    if (res.statusCode !== 201) {
        throw new Error(`createSeededFileItem failed (${res.statusCode}): ${res.body}`);
    }

    return { itemId, chunkSetId };
}

// ── DB helper functions for the tests ────────────────────────────────────────

export async function insertUser(id = "user-1") {
    await db.insert(users).values({
        id,
        email: `${id}@test.com`,
        auth_key_hash: "hash",
        kdf_salt: Buffer.alloc(16),
        kdf_params: '{"m":1024,"t":1,"p":1}',
        encrypted_vault_key: Buffer.alloc(48),
        vault_key_nonce: Buffer.alloc(24),
    });
}

export async function insertChunkSet(
    id: string,
    userId: string,
    opts: { totalSize?: number; pendingDeleteAt?: number | null; createdAt?: number } = {},
) {
    await db.insert(chunkSets).values({
        id,
        user_id: userId,
        chunk_count: 1,
        total_size: opts.totalSize ?? 1000,
        pending_delete_at: opts.pendingDeleteAt ?? null,
        created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    });
}

export async function insertUploadSession(
    id: string,
    userId: string,
    status: "uploading" | "committed" | "aborted" | "restore_staging" | "purged",
    updatedAt: number,
    totalSize = 0,
    chunkSizes: number[] = [totalSize || 64],
) {
    await db.insert(uploadSessions).values({
        id,
        user_id: userId,
        expected_chunks: chunkSizes.length,
        total_size: totalSize || chunkSizes.reduce((a, b) => a + b, 0),
        chunk_sizes: chunkSizes,
        status,
        created_at: updatedAt,
        updated_at: updatedAt,
    });
}

export async function insertFileChunk(
    chunkSetId: string,
    chunkIndex: number,
    userId: string,
    size: number,
) {
    await db
        .insert(fileChunks)
        .values({ chunk_set_id: chunkSetId, chunk_index: chunkIndex, user_id: userId, size });
}

export async function insertLiveItem(itemId: string, userId: string, chunkSetId: string) {
    await db.insert(items).values({
        id: itemId,
        user_id: userId,
        type: "file",
        sort_order: "m",
        chunk_set_id: chunkSetId,
        version: 1,
    });
}

export async function insertDeletedItem(
    itemId: string,
    userId: string,
    chunkSetId: string | null,
    deletedAt: number,
) {
    await db.insert(items).values({
        id: itemId,
        user_id: userId,
        type: "file",
        sort_order: "m",
        chunk_set_id: chunkSetId,
        version: 2,
        deleted_at: deletedAt,
    });
}

/** Insert a hard-deleted tombstone (purged_at set, blobs null) — for the GC sweep tests. */
export async function insertTombstoneItem(
    itemId: string,
    userId: string,
    purgedAt: number,
    opts: { type?: string; parentId?: string | null } = {},
) {
    await db.insert(items).values({
        id: itemId,
        user_id: userId,
        type: opts.type ?? "note",
        parent_id: opts.parentId ?? null,
        sort_order: "m",
        version: 3,
        deleted_at: purgedAt,
        purged_at: purgedAt,
    });
}

/** Counts the items rows for a given id (0 or 1). */
export async function countItemRows(itemId: string): Promise<number> {
    const [row] = await db
        .select({ n: sql<number>`COUNT(*)::integer` })
        .from(items)
        .where(eq(items.id, itemId));
    return row?.n ?? 0;
}

/** Fetches pending_delete_at for a chunk set. */
export async function getChunkSetPendingDeleteAt(id: string): Promise<number | null | undefined> {
    const [row] = await db
        .select({ pending_delete_at: chunkSets.pending_delete_at })
        .from(chunkSets)
        .where(eq(chunkSets.id, id))
        .limit(1);
    return row?.pending_delete_at;
}

/** Fetches a user's storage_used_files. */
export async function getUserStorageUsed(email: string): Promise<number> {
    const [row] = await db
        .select({ storage_used_files: users.storage_used_files })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    return row?.storage_used_files ?? 0;
}

/** Fetches a user's storage_used_trash. */
export async function getUserStorageUsedTrash(email: string): Promise<number> {
    const [row] = await db
        .select({ storage_used_trash: users.storage_used_trash })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    return row?.storage_used_trash ?? 0;
}

/** Reads the generated `storage_used` (the sum of the 4 counters). */
export async function getUserStorageTotal(email: string): Promise<number> {
    const [row] = await db
        .select({ storage_used: users.storage_used })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    return row?.storage_used ?? 0;
}

/** Fetch storage_used_items (the payload bytes of a user's LIVE items). */
export async function getUserStorageUsedItems(email: string): Promise<number> {
    const [row] = await db
        .select({ storage_used_items: users.storage_used_items })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    return row?.storage_used_items ?? 0;
}

/** Sets storage_quota and storage_used_files directly in the DB. */
export async function setUserStorage(email: string, quota: number, used = 0) {
    await db
        .update(users)
        .set({ storage_quota: quota, storage_used_files: used })
        .where(eq(users.email, email));
}

/** Counts the rows in the upload_sessions table. */
export async function countUploadSessions(): Promise<number> {
    const [row] = await db.select({ n: sql<number>`COUNT(*)::integer` }).from(uploadSessions);
    return row?.n ?? 0;
}

/** Counts the rows in the chunk_sets table. */
export async function countChunkSets(): Promise<number> {
    const [row] = await db.select({ n: sql<number>`COUNT(*)::integer` }).from(chunkSets);
    return row?.n ?? 0;
}

/** Reads an upload session's status. */
export async function getUploadSessionStatus(id: string): Promise<string | undefined> {
    const [row] = await db
        .select({ status: uploadSessions.status })
        .from(uploadSessions)
        .where(eq(uploadSessions.id, id))
        .limit(1);
    return row?.status;
}

/** Counts the file_chunks for a given chunk_set_id. */
export async function countFileChunks(chunkSetId: string): Promise<number> {
    const [row] = await db
        .select({ n: sql<number>`COUNT(*)::integer` })
        .from(fileChunks)
        .where(eq(fileChunks.chunk_set_id, chunkSetId));
    return row?.n ?? 0;
}

/** Fetches a chunk_sets row. */
export async function getChunkSet(id: string) {
    const [row] = await db.select().from(chunkSets).where(eq(chunkSets.id, id)).limit(1);
    return row;
}

/** Fetches the user ID for a given email. */
export async function getUserIdByEmail(email: string): Promise<string | undefined> {
    const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
    return row?.id;
}

/** Fetches the sync_deleted_log entries for a given item. */
export async function getDeletedLogEntries(itemId: string) {
    return db.select().from(syncDeletedLog).where(eq(syncDeletedLog.item_id, itemId));
}

/** Inserts a sync_deleted_log row directly (for the GC retention tests). */
export async function insertDeletedLogEntry(userId: string, itemId: string, deletedAt: number) {
    await db
        .insert(syncDeletedLog)
        .values({ user_id: userId, item_id: itemId, deleted_at: deletedAt });
}

/** Counts the rows in sync_deleted_log. */
export async function countDeletedLogRows(): Promise<number> {
    const [row] = await db.select({ n: sql<number>`COUNT(*)::integer` }).from(syncDeletedLog);
    return row?.n ?? 0;
}
