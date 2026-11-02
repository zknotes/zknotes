-- A random segment for S3 keys instead of the user id, which every presigned URL given to an
-- anonymous share recipient revealed. Existing rows keep the user id as their prefix, so nothing in
-- the bucket moves; new rows get 32 random hex characters from the database. Upload sessions and
-- chunk sets carry a copy because a chunk set outlives the user row and GC deletes objects by it.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "storage_prefix" text;
--> statement-breakpoint
UPDATE "users" SET "storage_prefix" = "id" WHERE "storage_prefix" IS NULL;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "storage_prefix" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "storage_prefix" SET DEFAULT replace(gen_random_uuid()::text, '-', '');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_storage_prefix_idx" ON "users" USING btree ("storage_prefix");
--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "storage_prefix" text;
--> statement-breakpoint
UPDATE "upload_sessions" SET "storage_prefix" = "user_id" WHERE "storage_prefix" IS NULL;
--> statement-breakpoint
ALTER TABLE "upload_sessions" ALTER COLUMN "storage_prefix" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "upload_sessions" ALTER COLUMN "storage_prefix" SET DEFAULT replace(gen_random_uuid()::text, '-', '');
--> statement-breakpoint
ALTER TABLE "chunk_sets" ADD COLUMN IF NOT EXISTS "storage_prefix" text;
--> statement-breakpoint
UPDATE "chunk_sets" SET "storage_prefix" = "user_id" WHERE "storage_prefix" IS NULL;
--> statement-breakpoint
ALTER TABLE "chunk_sets" ALTER COLUMN "storage_prefix" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "chunk_sets" ALTER COLUMN "storage_prefix" SET DEFAULT replace(gen_random_uuid()::text, '-', '');
--> statement-breakpoint
-- Failed share-password checks per share and source (an IPv4 address or an IPv6 /64), the same
-- split as login_failures: one recipient guessing cannot lock the link for everyone else, and
-- share_links.failed_* stays as the per-share backstop with a far higher threshold.
CREATE TABLE IF NOT EXISTS "share_failures" (
    "share_id" text NOT NULL,
    "source" text NOT NULL,
    "failed_attempts" integer DEFAULT 0 NOT NULL,
    "window_started_at" bigint NOT NULL,
    "locked_until" bigint,
    CONSTRAINT "share_failures_share_id_source_pk" PRIMARY KEY ("share_id", "source"),
    CONSTRAINT "share_failures_share_id_share_links_id_fk" FOREIGN KEY ("share_id") REFERENCES "share_links" ("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_failures_window_idx" ON "share_failures" USING btree ("window_started_at");
