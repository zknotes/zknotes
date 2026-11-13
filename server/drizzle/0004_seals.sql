-- Proof-of-existence seals. One row per seal of a file's chunk set. The server holds only the
-- encrypted seal record (manifest, nonce, OpenTimestamps proof) and a per-seal key wrapped with the
-- Vault Key; it never stores the commitment that was sent to the calendars. A seal lives exactly as
-- long as the chunk set it seals: GC deletes it, with its quota, before it deletes the chunk set,
-- and the foreign key cascades as a backstop.
CREATE TABLE IF NOT EXISTS "seals" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL,
    "chunk_set_id" text NOT NULL,
    "state" text DEFAULT 'pending' NOT NULL,
    "encrypted_record" "bytea",
    "record_nonce" "bytea",
    "encrypted_seal_key" "bytea",
    "seal_key_nonce" "bytea",
    "created_at" bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    "updated_at" bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    CONSTRAINT "seals_state_check" CHECK ("state" IN ('pending', 'confirmed')),
    CONSTRAINT "seals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
    CONSTRAINT "seals_chunk_set_id_chunk_sets_id_fk" FOREIGN KEY ("chunk_set_id") REFERENCES "chunk_sets" ("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seals_user_created_idx" ON "seals" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seals_chunk_set_idx" ON "seals" USING btree ("chunk_set_id");
