import type { RestoreManifestItem } from "@zknotes/shared";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
    bigint,
    customType,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    text,
    uniqueIndex,
} from "drizzle-orm/pg-core";

// bytea is not exported explicitly in this version of drizzle-orm — we define it ourselves.
// postgres.js returns bytea as a Buffer; an explicit fromDriver guarantees the Buffer type always.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
    dataType() {
        return "bytea";
    },
    fromDriver(value) {
        return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    },
});

/** Default per-user storage quota in bytes (1 GiB). Changed with a per-user UPDATE. */
// The DDL default for new users. The real limit is set by the entitlements provider at
// registration (seam 2) — the core here **must not** know about plans. 1 GiB.
export const DEFAULT_STORAGE_QUOTA = 1_073_741_824;
/** DDL default per-user max file size — 50 MB; the provider may raise it at registration. */
export const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Every point in time is stored as epoch seconds in a `bigint`: a 32-bit `integer` overflows on
 * 2038-01-19, and a 30-day session expiry reaches that date a month earlier. `mode: "number"` keeps
 * the TypeScript type a plain number (safe up to 2^53).
 */
const epochSeconds = (name: string) => bigint(name, { mode: "number" });

const nowEpoch = sql`extract
    (epoch from now())
    ::bigint`;

/**
 * The `users` table holds each user's basic data, their cryptographic parameters for
 * authentication, and their storage usage.
 *
 * Non-obvious fields:
 * - `auth_key_hash`: A hash derived from the Auth Key, used solely to verify the password at login
 *   (the server does not know the password).
 * - `kdf_salt` / `kdf_params`: The parameters the client needs to derive its keys from the password
 *   (salt, iterations, memory).
 * - `storage_quota` / `storage_used`: Tracks the quota and space consumed in bytes to prevent abuse.
 *   `bigint` is used because quotas can exceed 2 GB.
 * - `max_file_size`: The per-user maximum size of a single file (plaintext, bytes) — "you get what
 *   you pay for". One limit for every file type, because a zero-knowledge server does not see the
 *   MIME type and so cannot enforce per-type limits. Enforced in POST /uploads; the client reads it
 *   through GET /me/storage. Changed with a per-user UPDATE (a plan change, for instance).
 */
export const users = pgTable(
    "users",
    {
        id: text("id").primaryKey(), // UUIDv7
        email: text("email").notNull(),
        auth_key_hash: text("auth_key_hash").notNull(),
        kdf_salt: bytea("kdf_salt").notNull(), // 16B
        kdf_params: text("kdf_params").notNull(), // JSON string
        encrypted_vault_key: bytea("encrypted_vault_key").notNull(), // 48B ciphertext (32B + 16B tag)
        vault_key_nonce: bytea("vault_key_nonce").notNull(), // 24B
        // bigint — quotas can exceed 2 GiB; mode:"number" keeps the TypeScript type as number
        storage_quota: bigint("storage_quota", { mode: "number" })
            .notNull()
            .default(DEFAULT_STORAGE_QUOTA),
        storage_used_files: bigint("storage_used_files", { mode: "number" }).notNull().default(0),
        storage_used_items: bigint("storage_used_items", { mode: "number" }).notNull().default(0),
        storage_used_history: bigint("storage_used_history", { mode: "number" })
            .notNull()
            .default(0),
        storage_used_trash: bigint("storage_used_trash", { mode: "number" }).notNull().default(0),
        storage_used: bigint("storage_used", { mode: "number" }).generatedAlwaysAs(
            sql`storage_used_files + storage_used_items + storage_used_history + storage_used_trash`,
        ),
        max_file_size: bigint("max_file_size", { mode: "number" })
            .notNull()
            .default(DEFAULT_MAX_FILE_SIZE),
        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
        updated_at: epochSeconds("updated_at").notNull().default(nowEpoch),
        locked_at: epochSeconds("locked_at"), // null = active; a timestamp = administratively locked
        // Anti-brute-force, account-wide: the backstop behind the per-source lock in `login_failures`
        // (services/login-throttle.ts). A temporary, self-expiring lock.
        failed_attempts: integer("failed_attempts").notNull().default(0),
        locked_until: epochSeconds("locked_until"), // null = not locked; epoch seconds, expires on its own
        /**
         * Start of the current run of failures. `failed_attempts` counts only within the account
         * window of it, so the backoff tracks a sustained run rather than a running total that an
         * attacker can walk to the cap and park there.
         */
        failed_window_started_at: epochSeconds("failed_window_started_at"),
        // Denormalised; it does not depend on session retention or deletion at logout.
        last_seen_at: epochSeconds("last_seen_at"),
        // Clickwrap Terms acceptance at registration. NULL = registered before it was introduced
        // (test accounts were backfilled by hand; a production re-acceptance mechanism has not been
        // built yet).
        accepted_terms_version: text("accepted_terms_version"),
        accepted_terms_at: epochSeconds("accepted_terms_at"),
    },
    (table) => [
        uniqueIndex("users_email_idx").on(table.email),
        // The address is stored and looked up lower-cased, so the uniqueness that matters is on
        // `lower(email)` — otherwise two rows differing only in case are two vaults, and a
        // normalised sign-in can only ever find one of them. Declared here so the
        // table and the hand-written migration cannot drift apart.
        uniqueIndex("users_email_lower_idx").on(sql`lower(${table.email})`),
        // A partial index — for the `locked_users` aggregate an extension's dashboard reads
        index("users_locked_at_idx").on(table.locked_at).where(sql`${table.locked_at} IS NOT NULL`),
        // Fast clearing of expired locks, and diagnostics for active backoff locks.
        index("users_locked_until_idx")
            .on(table.locked_until)
            .where(sql`${table.locked_until} IS NOT NULL`),
    ],
);

/**
 * Failed sign-ins per account **and source** — an IPv4 address or an IPv6 /64, the same subject the
 * per-IP rate limits count (`rateLimitSubject`). The lock that stops a guessing run is scoped to its
 * source, so one attacker who knows the address cannot keep the owner out from anywhere else. The
 * account-wide count on `users` (`failed_attempts`, `locked_until`, `failed_window_started_at`) is
 * the backstop against a run spread over many sources. See services/login-throttle.ts.
 */
export const loginFailures = pgTable(
    "login_failures",
    {
        user_id: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        source: text("source").notNull(),
        failed_attempts: integer("failed_attempts").notNull().default(0),
        window_started_at: epochSeconds("window_started_at").notNull(),
        locked_until: epochSeconds("locked_until"),
    },
    (table) => [
        primaryKey({ columns: [table.user_id, table.source] }),
        // The GC sweep of runs whose window has lapsed.
        index("login_failures_window_idx").on(table.window_started_at),
    ],
);

/**
 * The `sessions` table holds a user's active sessions, keeping them signed in.
 *
 * Non-obvious fields:
 * - `id`: An opaque string used as the public ID for deleting sessions.
 * - `session_token`: The SHA-256 HASH of the session token. The user's cookie carries the raw
 *   token; the database stores only the hash — a DB leak yields no directly usable cookies. Lookup
 *   hashes the incoming cookie.
 * - `expires_at`: The timestamp until which the session is valid. The server sweeps expired
 *   sessions regularly.
 */
export const sessions = pgTable(
    "sessions",
    {
        id: text("id").primaryKey(), // UUIDv7
        session_token: text("session_token").notNull().unique(), // opaque hex string
        user_id: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        expires_at: epochSeconds("expires_at").notNull(),
        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
        last_used_at: epochSeconds("last_used_at").notNull().default(nowEpoch),
        user_agent: text("user_agent"),
        ip_address: text("ip_address"),
    },
    (table) => [
        index("sessions_user_id_idx").on(table.user_id),
        index("sessions_expires_at_idx").on(table.expires_at),
    ],
);

/**
 * The `items` table is the application's central table: it holds the hierarchy and the encrypted
 * content (notes, folders and files). The server can read neither the content nor the metadata of
 * an item, because both are end-to-end encrypted.
 *
 * Non-obvious fields:
 * - `type`: One of "note", "folder" or "file".
 * - `parent_id`: For `type:"file"` — the ID of the note the file belongs to (its owner note). For a
 *   note or folder — the ID of the parent folder.
 * - `encrypted_payload`: The encrypted JSON content (the note's text, or a file's metadata). It is
 *   **kept** while TRASHED (needed to show the item in Trash and to restore it); it is nulled only
 *   on hard delete (purge).
 * - `encrypted_item_key`: The key specific to this item (its Item Key), wrapped with the **Vault
 *   Key** (not the Encryption Key — the EK only unwraps the VK and is then zeroized).
 *   The client decrypts this first so it can decrypt the payload.
 * - `chunk_set_id`: A reference to the file's own chunk set (1:1). The one exception is a conflict
 *   copy of a file: it shares the original's immutable chunk set (the copy re-wraps the same Item
 *   Key instead of re-encrypting the blob), so a set is released only once no non-purged item
 *   references it (`releaseChunkSetIfUnreferenced`). Applies only to `type:"file"`.
 * - `sort_order`: Fractional indexing (a string) — never parseInt it!
 * - `deleted_at`: The soft-delete timestamp. The TRASHED state — the file is in Trash and its blob
 *   remains (restorable). The payload is NOT deleted on soft delete.
 * - `purged_at`: The hard-delete timestamp. The DELETED state — the blob goes to pending_delete and
 *   only a tombstone row remains. Discriminator: purged_at IS NOT NULL = tombstone.
 */
export const items = pgTable(
    "items",
    {
        id: text("id").primaryKey(), // UUIDv7
        user_id: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        type: text("type").notNull(), // "note" | "folder" | "file"
        parent_id: text("parent_id").references((): AnyPgColumn => items.id, {
            onDelete: "cascade",
        }),

        // Null only for DELETED (the purge tombstone); kept while TRASHED so Trash can show and
        // restore the item
        encrypted_payload: bytea("encrypted_payload"),
        payload_nonce: bytea("payload_nonce"),
        encrypted_item_key: bytea("encrypted_item_key"),
        item_key_nonce: bytea("item_key_nonce"),

        // File-only plaintext fields (null for a note or folder; kept even while TRASHED so the sweeper can locate the blob)
        chunk_set_id: text("chunk_set_id"),
        chunk_count: integer("chunk_count"),
        ciphertext_size: bigint("ciphertext_size", { mode: "number" }),

        version: integer("version").notNull().default(1),
        sort_order: text("sort_order").notNull(),

        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
        updated_at: epochSeconds("updated_at").notNull().default(nowEpoch),
        deleted_at: epochSeconds("deleted_at"), // TRASHED: soft-delete timestamp
        trashed_batch_id: text("trashed_batch_id"), // The provenance ID for a batch restore
        purged_at: epochSeconds("purged_at"), // DELETED: hard-delete timestamp; IS NOT NULL = tombstone
    },
    (table) => [
        index("items_user_parent_idx").on(table.user_id, table.parent_id),
        index("items_user_updated_idx").on(table.user_id, table.updated_at, table.id),
        index("items_user_deleted_idx")
            .on(table.user_id, table.deleted_at)
            .where(sql`${table.deleted_at} IS NOT NULL`),
        index("items_user_purged_idx")
            .on(table.user_id, table.purged_at)
            .where(sql`${table.purged_at} IS NOT NULL`),
        index("items_chunk_set_idx")
            .on(table.chunk_set_id)
            .where(sql`${table.chunk_set_id} IS NOT NULL`),
    ],
);

/**
 * The `upload_sessions` table holds the temporary sessions used to upload large files (multipart
 * upload).
 *
 * Non-obvious fields:
 * - `id`: The session ID, which becomes the `chunk_set_id` once the upload succeeds.
 * - `status`: The current state ("uploading", "committed", "aborted"). Once it becomes "committed",
 *   the data turns into a permanent `chunk_set`.
 */
export const uploadSessions = pgTable(
    "upload_sessions",
    {
        id: text("id").primaryKey(), // = chunk_set_id (UUIDv7)
        user_id: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        expected_chunks: integer("expected_chunks").notNull(),
        total_size: bigint("total_size", { mode: "number" }).notNull(),
        /** Per-chunk ciphertext sizes — needed for the lazy mint of presigned PUT URLs. */
        chunk_sizes: jsonb("chunk_sizes").$type<number[]>().notNull(),
        // uploading | committed | aborted | restore_staging | purged
        // `purged`: the committed blob was swept by GC (orphan sweep / deep-repair ghost row) —
        // the session must no longer answer `committed`, or a resuming client binds an item to bytes
        // that are gone. Set only by gc.ts; swept with the stale-upload window.
        status: text("status").notNull().default("uploading"),
        restore_session_id: text("restore_session_id").references(() => restoreSessions.id, {
            onDelete: "set null",
        }),
        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
        updated_at: epochSeconds("updated_at").notNull().default(nowEpoch),
    },
    (table) => [
        index("upload_sessions_user_idx").on(table.user_id, table.updated_at),
        index("upload_sessions_restore_idx")
            .on(table.restore_session_id)
            .where(sql`${table.restore_session_id} IS NOT NULL`),
    ],
);

/**
 * The `file_chunks` table holds the individual pieces (chunks) of a file. Because files are
 * end-to-end encrypted, the client cuts them into chunks and encrypts each one separately before
 * sending it.
 *
 * Non-obvious fields:
 * - `chunk_set_id`: The ID of the set this chunk belongs to (correlates with `chunk_sets.id`).
 * - `chunk_index`: The chunk's ordinal within the file, which matters for reassembling it correctly
 *   on download.
 */
export const fileChunks = pgTable(
    "file_chunks",
    {
        chunk_set_id: text("chunk_set_id").notNull(),
        chunk_index: integer("chunk_index").notNull(),
        user_id: text("user_id").notNull(),
        size: bigint("size", { mode: "number" }).notNull(),
        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
    },
    (table) => [
        primaryKey({ columns: [table.chunk_set_id, table.chunk_index] }),
        index("file_chunks_user_idx").on(table.user_id),
    ],
);

/**
 * The `chunk_sets` table represents fully uploaded and "committed" files (collections of chunks).
 * The strict 1:1 model (V3): every `chunk_set` belongs to **exactly one** `Item(type="file")` — it
 * is never shared.
 *
 * Non-obvious fields:
 * - `id`: A UUIDv7 matching `chunk_set_id` in the `items` table.
 * - `pending_delete_at`: The timestamp at which the blob was marked for asynchronous physical
 *   deletion (hard delete or crop). NULL = a live blob. IS NOT NULL = waiting for the async
 *   sweeper. The physical deletion (rmrf) is done by the sweeper only after BLOB_PURGE_GRACE (1h),
 *   which is what lets a crop be undone without putting the blob in Trash.
 *   The request path never touches R2 or disk directly — it only sets this marker.
 */
export const chunkSets = pgTable(
    "chunk_sets",
    {
        id: text("id").primaryKey(), // = upload_sessions.id / chunk_set_id
        user_id: text("user_id").notNull(),
        chunk_count: integer("chunk_count").notNull(),
        total_size: bigint("total_size", { mode: "number" }).notNull(),
        pending_delete_at: epochSeconds("pending_delete_at"), // null = live; set = waiting for the sweep
        restore_session_id: text("restore_session_id").references(() => restoreSessions.id, {
            onDelete: "set null",
        }),
        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
    },
    (table) => [
        index("chunk_sets_user_idx").on(table.user_id),
        index("chunk_sets_pending_delete_idx")
            .on(table.pending_delete_at)
            .where(sql`${table.pending_delete_at} IS NOT NULL`),
        index("chunk_sets_restore_idx")
            .on(table.restore_session_id)
            .where(sql`${table.restore_session_id} IS NOT NULL`),
    ],
);

/**
 * A restore wizard session. Staging is kept apart from `items` — no phase except the commit
 * changes the user's content. The quota is the exception.
 */
export const restoreSessions = pgTable(
    "restore_sessions",
    {
        id: text("id").primaryKey(),
        user_id: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        backup_hash: text("backup_hash").notNull(),
        mode: text("mode").notNull(), // skip_existing | overwrite_all
        status: text("status").notNull().default("open"), // open | committed | aborted | expired
        manifest: jsonb("manifest").$type<RestoreManifestItem[]>().notNull(),
        collision_versions: jsonb("collision_versions").$type<Record<string, number>>().notNull(),
        expires_at: epochSeconds("expires_at").notNull(),
        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
        updated_at: epochSeconds("updated_at").notNull().default(nowEpoch),
    },
    (table) => [
        uniqueIndex("restore_sessions_one_open_per_user")
            .on(table.user_id)
            .where(sql`${table.status} = 'open'`),
        index("restore_sessions_user_idx").on(table.user_id, table.status),
        index("restore_sessions_expires_idx").on(table.expires_at),
    ],
);

/** Staged ciphertext bound to a restore session — idempotent by (session, item id). */
export const restoreStagedItems = pgTable(
    "restore_staged_items",
    {
        restore_session_id: text("restore_session_id")
            .notNull()
            .references(() => restoreSessions.id, { onDelete: "cascade" }),
        id: text("id").notNull(),
        type: text("type").notNull(),
        parent_id: text("parent_id"),
        encrypted_payload: bytea("encrypted_payload"),
        payload_nonce: bytea("payload_nonce"),
        encrypted_item_key: bytea("encrypted_item_key"),
        item_key_nonce: bytea("item_key_nonce"),
        sort_order: text("sort_order").notNull(),
        version: integer("version").notNull().default(1),
        chunk_set_id: text("chunk_set_id"),
        chunk_count: integer("chunk_count"),
        ciphertext_size: bigint("ciphertext_size", { mode: "number" }),
        byte_size: integer("byte_size").notNull(),
        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
    },
    (table) => [primaryKey({ columns: [table.restore_session_id, table.id] })],
);

/**
 * The `sync_deleted_log` table is the long-lived deletion log for delta sync. A hard delete
 * (purge) writes one row; `GET /items?since=` returns the entries past the watermark, and the
 * offline client deletes those IDs locally. That is what allows the `items` tombstone to be
 * short-lived (TOMBSTONE_PURGE_DAYS) — the long-term "this was deleted" signal is carried by this
 * log, not by the `items` row. Deliberately minimal (no blobs, no payloads) so it can live for
 * years (SYNC_DELETED_LOG_RETENTION).
 */
export const syncDeletedLog = pgTable(
    "sync_deleted_log",
    {
        user_id: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        item_id: text("item_id").notNull(),
        deleted_at: epochSeconds("deleted_at").notNull().default(nowEpoch),
    },
    (table) => [
        // The PK makes the write idempotent (onConflictDoNothing) — retrying a purge does not duplicate the row
        primaryKey({ columns: [table.user_id, table.item_id] }),
        index("sync_deleted_log_user_deleted_idx").on(
            table.user_id,
            table.deleted_at,
            table.item_id,
        ),
    ],
);

/** The hard limit on history snapshots per note. */
export const HISTORY_HARD_CAP = 50;

/**
 * The `item_history` table holds historical versions (snapshots) of notes.
 *
 * Non-obvious fields:
 * - `encrypted_payload`: A copy of the old encrypted JSON content as it was when the snapshot was
 *   taken.
 * - `encrypted_item_key`: The old encrypted key needed to decrypt that old payload (keys can be
 *   rotated, so the key the payload was encrypted with at the time has to be stored with it).
 * - `item_version_at_snapshot`: The version number (version bump) from the `items` table at the
 *   moment of the snapshot.
 */
export const itemHistory = pgTable(
    "item_history",
    {
        id: text("id").primaryKey(), // UUIDv7
        item_id: text("item_id")
            .notNull()
            .references(() => items.id, { onDelete: "cascade" }),
        user_id: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        encrypted_payload: bytea("encrypted_payload").notNull(),
        payload_nonce: bytea("payload_nonce").notNull(),
        encrypted_item_key: bytea("encrypted_item_key").notNull(),
        item_key_nonce: bytea("item_key_nonce").notNull(),
        item_version_at_snapshot: integer("item_version_at_snapshot").notNull(),
        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
    },
    (table) => [
        index("item_history_item_idx").on(table.item_id, table.created_at),
        index("item_history_user_idx").on(table.user_id, table.created_at),
    ],
);

/**
 * The `share_links` table — a live share pointer to a note.
 * The server holds only the wrapped Item Key; the ciphertext is read from `items` on view.
 */
export const shareLinks = pgTable(
    "share_links",
    {
        id: text("id").primaryKey(),
        user_id: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        source_item_id: text("source_item_id")
            .notNull()
            .references(() => items.id, { onDelete: "cascade" }),
        wrapped_item_key: bytea("wrapped_item_key").notNull(),
        item_key_nonce: bytea("item_key_nonce").notNull(),
        share_auth_key_hash: text("share_auth_key_hash"),
        share_kdf_salt: bytea("share_kdf_salt"),
        share_kdf_params: text("share_kdf_params"),
        /** SHA-256 hex of view_proof (HKDF from the link key). NULL is a pre-proof leftover; the gate refuses it. */
        view_proof_hash: text("view_proof_hash"),
        /** Per-share password brute-force counter (the same pattern as users.failed_attempts). */
        failed_attempts: integer("failed_attempts").notNull().default(0),
        locked_until: epochSeconds("locked_until"),
        /**
         * Start of the current run of password failures. `failed_attempts` counts only within
         * SHARE_PASSWORD_FAIL_WINDOW_SECONDS of it, so the backoff tracks a sustained run rather
         * than a running total that a holder of the link can walk to the cap and park there.
         */
        failed_window_started_at: epochSeconds("failed_window_started_at"),
        expires_at: epochSeconds("expires_at"),
        max_views: integer("max_views"),
        view_count: integer("view_count").notNull().default(0),
        revoked_at: epochSeconds("revoked_at"),
        last_viewed_at: epochSeconds("last_viewed_at"),
        /**
         * Deadline until which a burned link still serves its attachments, so the view that consumed
         * it does not cut its own download short. NULL = no window; revoke and the expiry sweep clear
         * it, which is why it is stored rather than inferred from the timestamps.
         */
        burn_grace_until: epochSeconds("burn_grace_until"),
        created_at: epochSeconds("created_at").notNull().default(nowEpoch),
        updated_at: epochSeconds("updated_at").notNull().default(nowEpoch),
    },
    (table) => [
        index("share_links_user_created_idx").on(table.user_id, table.created_at),
        // The cascade from `items` looks rows up by source item, revoked ones included; the partial
        // unique index below covers only the active link.
        index("share_links_source_item_idx").on(table.source_item_id),
        uniqueIndex("share_links_active_source_item_idx")
            .on(table.source_item_id)
            .where(sql`${table.revoked_at} IS NULL`),
    ],
);

/**
 * The wrapped Item Keys of the file attachments in a share link. No ciphertext — key material
 * only.
 */
export const shareAttachments = pgTable(
    "share_attachments",
    {
        share_id: text("share_id")
            .notNull()
            .references(() => shareLinks.id, { onDelete: "cascade" }),
        file_id: text("file_id")
            .notNull()
            .references(() => items.id, { onDelete: "cascade" }),
        wrapped_item_key: bytea("wrapped_item_key").notNull(),
        item_key_nonce: bytea("item_key_nonce").notNull(),
    },
    (table) => [primaryKey({ columns: [table.share_id, table.file_id] })],
);

// ── Server-side analytics ──

/** A short-lived working table for exact DAU/MAU — it holds user_id, retained ~38 days. */
export const analyticsDailyActiveUsers = pgTable(
    "analytics_daily_active_users",
    {
        day: epochSeconds("day").notNull(), // UTC midnight, epoch seconds
        user_id: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
    },
    (table) => [
        primaryKey({ columns: [table.day, table.user_id] }),
        index("analytics_dau_day_idx").on(table.day),
    ],
);

/** The permanent daily activity aggregate — no identities, retained 24 months. */
export const analyticsActiveUsersDaily = pgTable("analytics_active_users_daily", {
    day: epochSeconds("day").primaryKey(), // the day being summed (yesterday, in the daily job)
    dau: integer("dau").notNull(),
    mau: integer("mau").notNull(),
    total_accounts: integer("total_accounts").notNull(),
});

/** Traffic and latency per normalised route — a daily aggregate. */
export const analyticsRouteDaily = pgTable(
    "analytics_route_daily",
    {
        day: epochSeconds("day").notNull(),
        method: text("method").notNull(),
        route: text("route").notNull(),
        status_class: text("status_class").notNull(), // 2xx | 4xx | 5xx
        request_count: integer("request_count").notNull().default(0),
        latency_sum_ms: bigint("latency_sum_ms", { mode: "number" }).notNull().default(0),
        latency_max_ms: integer("latency_max_ms").notNull().default(0),
    },
    (table) => [
        primaryKey({ columns: [table.day, table.method, table.route, table.status_class] }),
        index("analytics_route_daily_day_idx").on(table.day),
    ],
);

/** Registration and login counters — a daily aggregate. */
export const analyticsAuthDaily = pgTable("analytics_auth_daily", {
    day: epochSeconds("day").primaryKey(),
    registrations: integer("registrations").notNull().default(0),
    login_success: integer("login_success").notNull().default(0),
    login_failure: integer("login_failure").notNull().default(0),
});

/** Storage/quota utilisation per tier (the storage_quota value) — a daily snapshot. */
export const analyticsStorageQuotaDaily = pgTable(
    "analytics_storage_quota_daily",
    {
        day: epochSeconds("day").notNull(),
        storage_quota: bigint("storage_quota", { mode: "number" }).notNull(),
        account_count: integer("account_count").notNull(),
        avg_usage_pct: integer("avg_usage_pct").notNull(),
        p50_usage_pct: integer("p50_usage_pct"),
        p95_usage_pct: integer("p95_usage_pct"),
    },
    (table) => [
        primaryKey({ columns: [table.day, table.storage_quota] }),
        index("analytics_storage_quota_daily_day_idx").on(table.day),
    ],
);

/**
 * When each rare maintenance job last started and last succeeded — one row per job. The
 * deep repair is due about weekly, while a deploy restarts the process more often than that, so its
 * schedule lives here and not in a process timer. `last_started_at` doubles as the claim's lease.
 */
export const gcRuns = pgTable("gc_runs", {
    job: text("job").primaryKey(),
    last_started_at: epochSeconds("last_started_at").notNull(),
    last_success_at: epochSeconds("last_success_at"),
});
