-- Brings the database in line with server/src/db/schema.ts, and stores every point in time as a
-- 64-bit integer.
--
-- 1. Four defaults the baseline carried and the schema does not declare. The two on key material
--    are the important ones: with them, an INSERT that forgot the wrapped Vault Key succeeded with a
--    one-byte placeholder instead of failing.
-- 2. An index for the ON DELETE CASCADE from items to share_links: the only index on
--    source_item_id was partial (active links only), so every item deletion scanned share_links.
-- 3. Epoch seconds move from integer to bigint. A 32-bit integer overflows on 2038-01-19, and a
--    30-day session expiry reaches that date a month earlier. The defaults follow the new type.
ALTER TABLE "users" ALTER COLUMN "encrypted_vault_key" DROP DEFAULT, ALTER COLUMN "vault_key_nonce" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "restore_sessions" ALTER COLUMN "collision_versions" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "upload_sessions" ALTER COLUMN "chunk_sizes" DROP DEFAULT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_links_source_item_idx" ON "share_links" USING btree ("source_item_id");
--> statement-breakpoint
ALTER TABLE "users"
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint,
    ALTER COLUMN "updated_at" SET DATA TYPE bigint,
    ALTER COLUMN "updated_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint,
    ALTER COLUMN "locked_at" SET DATA TYPE bigint,
    ALTER COLUMN "locked_until" SET DATA TYPE bigint,
    ALTER COLUMN "failed_window_started_at" SET DATA TYPE bigint,
    ALTER COLUMN "last_seen_at" SET DATA TYPE bigint,
    ALTER COLUMN "accepted_terms_at" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "sessions"
    ALTER COLUMN "expires_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint,
    ALTER COLUMN "last_used_at" SET DATA TYPE bigint,
    ALTER COLUMN "last_used_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint;
--> statement-breakpoint
ALTER TABLE "items"
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint,
    ALTER COLUMN "updated_at" SET DATA TYPE bigint,
    ALTER COLUMN "updated_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint,
    ALTER COLUMN "deleted_at" SET DATA TYPE bigint,
    ALTER COLUMN "purged_at" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "upload_sessions"
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint,
    ALTER COLUMN "updated_at" SET DATA TYPE bigint,
    ALTER COLUMN "updated_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint;
--> statement-breakpoint
ALTER TABLE "file_chunks"
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint;
--> statement-breakpoint
ALTER TABLE "chunk_sets"
    ALTER COLUMN "pending_delete_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint;
--> statement-breakpoint
ALTER TABLE "restore_sessions"
    ALTER COLUMN "expires_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint,
    ALTER COLUMN "updated_at" SET DATA TYPE bigint,
    ALTER COLUMN "updated_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint;
--> statement-breakpoint
ALTER TABLE "restore_staged_items"
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint;
--> statement-breakpoint
ALTER TABLE "sync_deleted_log"
    ALTER COLUMN "deleted_at" SET DATA TYPE bigint,
    ALTER COLUMN "deleted_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint;
--> statement-breakpoint
ALTER TABLE "item_history"
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint;
--> statement-breakpoint
ALTER TABLE "share_links"
    ALTER COLUMN "locked_until" SET DATA TYPE bigint,
    ALTER COLUMN "failed_window_started_at" SET DATA TYPE bigint,
    ALTER COLUMN "expires_at" SET DATA TYPE bigint,
    ALTER COLUMN "revoked_at" SET DATA TYPE bigint,
    ALTER COLUMN "last_viewed_at" SET DATA TYPE bigint,
    ALTER COLUMN "burn_grace_until" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DATA TYPE bigint,
    ALTER COLUMN "created_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint,
    ALTER COLUMN "updated_at" SET DATA TYPE bigint,
    ALTER COLUMN "updated_at" SET DEFAULT (EXTRACT(epoch FROM now()))::bigint;
--> statement-breakpoint
ALTER TABLE "analytics_daily_active_users"
    ALTER COLUMN "day" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "analytics_active_users_daily"
    ALTER COLUMN "day" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "analytics_route_daily"
    ALTER COLUMN "day" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "analytics_auth_daily"
    ALTER COLUMN "day" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "analytics_storage_quota_daily"
    ALTER COLUMN "day" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "gc_runs"
    ALTER COLUMN "last_started_at" SET DATA TYPE bigint,
    ALTER COLUMN "last_success_at" SET DATA TYPE bigint;
