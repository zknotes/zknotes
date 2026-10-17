-- The initial schema of the ZKnotes core: every table, constraint and index in one migration.
--
-- Its journal `when` equals the last migration that existing databases already applied, so the
-- migrator skips it there and only a new database starts from it. A new migration needs a later
-- `when` than this one.

CREATE TABLE analytics_active_users_daily (
    day integer NOT NULL,
    dau integer NOT NULL,
    mau integer NOT NULL,
    total_accounts integer NOT NULL,
    CONSTRAINT analytics_active_users_daily_pkey PRIMARY KEY (day)
);
--> statement-breakpoint
CREATE TABLE analytics_auth_daily (
    day integer NOT NULL,
    registrations integer DEFAULT 0 NOT NULL,
    login_success integer DEFAULT 0 NOT NULL,
    login_failure integer DEFAULT 0 NOT NULL,
    CONSTRAINT analytics_auth_daily_pkey PRIMARY KEY (day)
);
--> statement-breakpoint
CREATE TABLE analytics_route_daily (
    day integer NOT NULL,
    method text NOT NULL,
    route text NOT NULL,
    status_class text NOT NULL,
    request_count integer DEFAULT 0 NOT NULL,
    latency_sum_ms bigint DEFAULT 0 NOT NULL,
    latency_max_ms integer DEFAULT 0 NOT NULL,
    CONSTRAINT analytics_route_daily_day_method_route_status_class_pk PRIMARY KEY (day, method, route, status_class)
);
--> statement-breakpoint
CREATE TABLE analytics_storage_quota_daily (
    day integer NOT NULL,
    storage_quota bigint NOT NULL,
    account_count integer NOT NULL,
    avg_usage_pct integer NOT NULL,
    p50_usage_pct integer,
    p95_usage_pct integer,
    CONSTRAINT analytics_storage_quota_daily_day_storage_quota_pk PRIMARY KEY (day, storage_quota)
);
--> statement-breakpoint
CREATE TABLE file_chunks (
    chunk_set_id text NOT NULL,
    chunk_index integer NOT NULL,
    user_id text NOT NULL,
    size bigint NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT file_chunks_chunk_set_id_chunk_index_pk PRIMARY KEY (chunk_set_id, chunk_index)
);
--> statement-breakpoint
CREATE TABLE gc_runs (
    job text NOT NULL,
    last_started_at integer NOT NULL,
    last_success_at integer,
    CONSTRAINT gc_runs_pkey PRIMARY KEY (job)
);
--> statement-breakpoint
CREATE TABLE users (
    id text NOT NULL,
    email text NOT NULL,
    auth_key_hash text NOT NULL,
    kdf_salt bytea NOT NULL,
    kdf_params text NOT NULL,
    storage_quota bigint DEFAULT 1073741824 NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    max_file_size bigint DEFAULT 52428800 NOT NULL,
    locked_at integer,
    encrypted_vault_key bytea DEFAULT '\x00'::bytea NOT NULL,
    vault_key_nonce bytea DEFAULT '\x00'::bytea NOT NULL,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until integer,
    storage_used_files bigint DEFAULT 0 NOT NULL,
    storage_used_items bigint DEFAULT 0 NOT NULL,
    storage_used_history bigint DEFAULT 0 NOT NULL,
    storage_used_trash bigint DEFAULT 0 NOT NULL,
    storage_used bigint GENERATED ALWAYS AS ((((storage_used_files + storage_used_items) + storage_used_history) + storage_used_trash)) STORED,
    last_seen_at integer,
    accepted_terms_version text,
    accepted_terms_at integer,
    failed_window_started_at integer,
    CONSTRAINT users_pkey PRIMARY KEY (id)
);
--> statement-breakpoint
CREATE TABLE analytics_daily_active_users (
    day integer NOT NULL,
    user_id text NOT NULL,
    CONSTRAINT analytics_daily_active_users_day_user_id_pk PRIMARY KEY (day, user_id),
    CONSTRAINT analytics_daily_active_users_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE items (
    id text NOT NULL,
    user_id text NOT NULL,
    type text NOT NULL,
    parent_id text,
    encrypted_payload bytea,
    payload_nonce bytea,
    encrypted_item_key bytea,
    item_key_nonce bytea,
    chunk_set_id text,
    chunk_count integer,
    ciphertext_size bigint,
    version integer DEFAULT 1 NOT NULL,
    sort_order text NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    deleted_at integer,
    purged_at integer,
    trashed_batch_id text,
    CONSTRAINT items_pkey PRIMARY KEY (id),
    CONSTRAINT items_parent_id_items_id_fk FOREIGN KEY (parent_id) REFERENCES items(id) ON DELETE CASCADE,
    CONSTRAINT items_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE item_history (
    id text NOT NULL,
    item_id text NOT NULL,
    user_id text NOT NULL,
    encrypted_payload bytea NOT NULL,
    payload_nonce bytea NOT NULL,
    encrypted_item_key bytea NOT NULL,
    item_key_nonce bytea NOT NULL,
    item_version_at_snapshot integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT item_history_pkey PRIMARY KEY (id),
    CONSTRAINT item_history_item_id_items_id_fk FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
    CONSTRAINT item_history_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE restore_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    backup_hash text NOT NULL,
    mode text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    manifest jsonb NOT NULL,
    collision_versions jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT restore_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT restore_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE chunk_sets (
    id text NOT NULL,
    user_id text NOT NULL,
    chunk_count integer NOT NULL,
    total_size bigint NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    pending_delete_at integer,
    restore_session_id text,
    CONSTRAINT chunk_sets_pkey PRIMARY KEY (id),
    CONSTRAINT chunk_sets_restore_session_id_fkey FOREIGN KEY (restore_session_id) REFERENCES restore_sessions(id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE restore_staged_items (
    restore_session_id text NOT NULL,
    id text NOT NULL,
    type text NOT NULL,
    parent_id text,
    encrypted_payload bytea,
    payload_nonce bytea,
    encrypted_item_key bytea,
    item_key_nonce bytea,
    sort_order text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    chunk_set_id text,
    chunk_count integer,
    ciphertext_size bigint,
    byte_size integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT restore_staged_items_restore_session_id_id_pk PRIMARY KEY (restore_session_id, id),
    CONSTRAINT restore_staged_items_restore_session_id_fkey FOREIGN KEY (restore_session_id) REFERENCES restore_sessions(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    expires_at integer NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    last_used_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    user_agent text,
    ip_address text,
    session_token text NOT NULL,
    CONSTRAINT sessions_pkey PRIMARY KEY (id),
    CONSTRAINT sessions_session_token_unique UNIQUE (session_token),
    CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE share_links (
    id text NOT NULL,
    user_id text NOT NULL,
    source_item_id text NOT NULL,
    wrapped_item_key bytea NOT NULL,
    item_key_nonce bytea NOT NULL,
    share_auth_key_hash text,
    share_kdf_salt bytea,
    share_kdf_params text,
    expires_at integer,
    max_views integer,
    view_count integer DEFAULT 0 NOT NULL,
    revoked_at integer,
    last_viewed_at integer,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    view_proof_hash text,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until integer,
    burn_grace_until integer,
    failed_window_started_at integer,
    CONSTRAINT share_links_pkey PRIMARY KEY (id),
    CONSTRAINT share_links_source_item_id_items_id_fk FOREIGN KEY (source_item_id) REFERENCES items(id) ON DELETE CASCADE,
    CONSTRAINT share_links_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE share_attachments (
    share_id text NOT NULL,
    file_id text NOT NULL,
    wrapped_item_key bytea NOT NULL,
    item_key_nonce bytea NOT NULL,
    CONSTRAINT share_attachments_share_id_file_id_pk PRIMARY KEY (share_id, file_id),
    CONSTRAINT share_attachments_file_id_items_id_fk FOREIGN KEY (file_id) REFERENCES items(id) ON DELETE CASCADE,
    CONSTRAINT share_attachments_share_id_share_links_id_fk FOREIGN KEY (share_id) REFERENCES share_links(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE sync_deleted_log (
    user_id text NOT NULL,
    item_id text NOT NULL,
    deleted_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    CONSTRAINT sync_deleted_log_user_id_item_id_pk PRIMARY KEY (user_id, item_id),
    CONSTRAINT sync_deleted_log_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE upload_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    expected_chunks integer NOT NULL,
    total_size bigint NOT NULL,
    status text DEFAULT 'uploading'::text NOT NULL,
    created_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    updated_at integer DEFAULT (EXTRACT(epoch FROM now()))::integer NOT NULL,
    chunk_sizes jsonb DEFAULT '[]'::jsonb NOT NULL,
    restore_session_id text,
    CONSTRAINT upload_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT upload_sessions_restore_session_id_fkey FOREIGN KEY (restore_session_id) REFERENCES restore_sessions(id) ON DELETE SET NULL,
    CONSTRAINT upload_sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX analytics_dau_day_idx ON analytics_daily_active_users USING btree (day);
--> statement-breakpoint
CREATE INDEX analytics_route_daily_day_idx ON analytics_route_daily USING btree (day);
--> statement-breakpoint
CREATE INDEX analytics_storage_quota_daily_day_idx ON analytics_storage_quota_daily USING btree (day);
--> statement-breakpoint
CREATE INDEX chunk_sets_pending_delete_idx ON chunk_sets USING btree (pending_delete_at) WHERE (pending_delete_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX chunk_sets_restore_idx ON chunk_sets USING btree (restore_session_id) WHERE (restore_session_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX chunk_sets_user_idx ON chunk_sets USING btree (user_id);
--> statement-breakpoint
CREATE INDEX file_chunks_user_idx ON file_chunks USING btree (user_id);
--> statement-breakpoint
CREATE INDEX item_history_item_idx ON item_history USING btree (item_id, created_at);
--> statement-breakpoint
CREATE INDEX item_history_user_idx ON item_history USING btree (user_id, created_at);
--> statement-breakpoint
CREATE INDEX items_chunk_set_idx ON items USING btree (chunk_set_id) WHERE (chunk_set_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX items_user_deleted_idx ON items USING btree (user_id, deleted_at) WHERE (deleted_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX items_user_parent_idx ON items USING btree (user_id, parent_id);
--> statement-breakpoint
CREATE INDEX items_user_purged_idx ON items USING btree (user_id, purged_at) WHERE (purged_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX items_user_updated_idx ON items USING btree (user_id, updated_at, id);
--> statement-breakpoint
CREATE INDEX restore_sessions_expires_idx ON restore_sessions USING btree (expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX restore_sessions_one_open_per_user ON restore_sessions USING btree (user_id) WHERE (status = 'open'::text);
--> statement-breakpoint
CREATE INDEX restore_sessions_user_idx ON restore_sessions USING btree (user_id, status);
--> statement-breakpoint
CREATE INDEX sessions_expires_at_idx ON sessions USING btree (expires_at);
--> statement-breakpoint
CREATE INDEX sessions_user_id_idx ON sessions USING btree (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX share_links_active_source_item_idx ON share_links USING btree (source_item_id) WHERE (revoked_at IS NULL);
--> statement-breakpoint
CREATE INDEX share_links_user_created_idx ON share_links USING btree (user_id, created_at);
--> statement-breakpoint
CREATE INDEX sync_deleted_log_user_deleted_idx ON sync_deleted_log USING btree (user_id, deleted_at, item_id);
--> statement-breakpoint
CREATE INDEX upload_sessions_restore_idx ON upload_sessions USING btree (restore_session_id) WHERE (restore_session_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX upload_sessions_user_idx ON upload_sessions USING btree (user_id, updated_at);
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_idx ON users USING btree (email);
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_lower_idx ON users USING btree (lower(email));
--> statement-breakpoint
CREATE INDEX users_locked_at_idx ON users USING btree (locked_at) WHERE (locked_at IS NOT NULL);
--> statement-breakpoint
CREATE INDEX users_locked_until_idx ON users USING btree (locked_until) WHERE (locked_until IS NOT NULL);
