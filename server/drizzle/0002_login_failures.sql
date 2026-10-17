-- Failed sign-ins per account and source (an IPv4 address or an IPv6 /64). The lock that stops a
-- guessing run applies to its source only, so an attacker who knows an address can no longer keep
-- the owner out; users.failed_attempts stays as the account-wide backstop.
CREATE TABLE IF NOT EXISTS "login_failures" (
    "user_id" text NOT NULL,
    "source" text NOT NULL,
    "failed_attempts" integer DEFAULT 0 NOT NULL,
    "window_started_at" bigint NOT NULL,
    "locked_until" bigint,
    CONSTRAINT "login_failures_user_id_source_pk" PRIMARY KEY ("user_id", "source"),
    CONSTRAINT "login_failures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_failures_window_idx" ON "login_failures" USING btree ("window_started_at");
