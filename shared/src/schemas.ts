import * as zod from "zod";

const z = zod.z || (zod as any).default?.z || zod;

// TODO: string() before email()/uuid() is deprecated in Zod 4; migrate to the top-level validators.
// Re-exported so workspace consumers (the API, for instance) can use Zod without depending on it directly.
export { z };

// Zod v4 probes `Function('')` to decide whether it may JIT-compile fast validators. Under an
// enforced CSP without 'unsafe-eval' (client svelte.config.js kit.csp — only 'wasm-unsafe-eval'
// for hash-wasm Argon2id) that call throws; Zod catches it and falls back to the slow path, BUT
// the CSP violation is still reported (confirmed in client/e2e/29-csp-enforce.spec.ts).
// `jitless: true` at module top level skips the probe before any schema in this file even exists
// — it has to sit HERE, not in client code that imports the schemas, because bundle order does
// not guarantee the app code runs first. Same Vite/Bun signal as the KDF test-mode check in
// cryptography.ts: present only in a Vite-built context (browser main thread + crypto.worker.ts),
// not on the API (Bun, no CSP, JIT stays on for throughput).
if (typeof (import.meta as any).env !== "undefined") {
    z.config({ jitless: true });
}

/**
 * The canonical form of an email address — **one source of truth**, shared by the client and the API.
 *
 * A vault row is written under this form, so every lookup has to use it too. While only the write
 * side normalised, registering as `Alice@Example.com` and then signing in with that same address
 * missed the row it had just created: `/auth/kdf-params` answered with the anti-enumeration fake
 * salt, the browser derived the wrong Master Key from it, and `/auth/login` returned "Invalid
 * credentials" for a perfectly correct password. Mobile keyboards capitalise the first letter of an
 * address by default, and there is no password recovery here — the vault was simply gone.
 *
 * Lowercasing the domain is uncontroversial (DNS is case-insensitive). Lowercasing the local part is
 * technically a choice — RFC 5321 §2.3.11 leaves its case to the receiving host — but every mail
 * provider in practice treats it case-insensitively, and it is the choice this product already made
 * when it wrote the row.
 */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

/** Allowed base64 characters, padding included — one source of truth for the auth/kdf fields. */
const B64_CHARS = /^[A-Za-z0-9+/=]+$/;

/**
 * A 24-byte XChaCha20-Poly1305 nonce on the wire: exactly 32 base64 characters with NO
 * padding (24 B divides by 3 → no `=`). The regex guarantees both the correct alphabet and a
 * decoded length of 24 B, unlike a bare `.length(32)`, which let through non-base64 junk of the
 * same length.
 */
const nonceB64Schema = z.string().regex(/^[A-Za-z0-9+/]{32}$/);

/**
 * Upper bound for `encrypted_payload` on the wire (10 MiB plaintext). Base64 is
 * ~4/3 larger — a cap on string length keeps the payload under ~10 MiB decoded, independently of
 * the 30 MB body limit.
 */
const MAX_ENCRYPTED_PAYLOAD_B64 = Math.ceil((10 * 1024 * 1024) / 3) * 4;

export const KdfParamsSchema = z.object({
    m: z.number().int().min(1024).max(1048576),
    t: z.number().int().min(1).max(10),
    p: z.number().int().min(1).max(16),
});

/**
 * Vault creation. The same crypto material as registration, **without** Terms acceptance: an
 * extended deployment keeps the account and the Terms outside the core, and a self-host has
 * neither.
 *
 * `token` is a one-time pass issued by an extension; on a self-host it is absent.
 */
export const VaultCreateSchema = z.object({
    email: z.email().max(254),
    auth_key: z
        .string()
        .regex(/^[A-Za-z0-9+/=]+$/)
        .length(44),
    kdf_salt: z
        .string()
        .regex(/^[A-Za-z0-9+/=]+$/)
        .length(24),
    kdf_params: KdfParamsSchema,
    encrypted_vault_key: z.string().regex(B64_CHARS).length(64),
    vault_key_nonce: z.string().regex(/^[A-Za-z0-9+/]{32}$/),
    token: z.string().min(32).max(128).optional(),
});
export type VaultCreateInput = zod.infer<typeof VaultCreateSchema>;

export const VerifyEmailSchema = z.object({
    token: z.string().min(1).max(128),
});

export type VerifyEmailRequest = zod.infer<typeof VerifyEmailSchema>;

export const LoginSchema = z.object({
    email: z.email().max(254),
    auth_key: z
        .string()
        .regex(/^[A-Za-z0-9+/=]+$/)
        .length(44),
});

const EncryptedItemObject = z.object({
    id: z.string().uuid(),
    type: z.enum(["note", "folder", "file"]),
    parent_id: z.string().uuid().nullable(),
    encrypted_payload: z.string().max(MAX_ENCRYPTED_PAYLOAD_B64).nullable(), // base64, nullable for a tombstone
    payload_nonce: nonceB64Schema.nullable(), // base64 24B = 32 characters
    encrypted_item_key: z.string().regex(B64_CHARS).length(64).nullable(), // 48B (32B key + 16B tag) base64
    item_key_nonce: nonceB64Schema.nullable(),
    version: z.number().int().min(1),
    sort_order: z.string().min(1).max(256), // fractional index string
    // Synced trash timestamp. The client is authoritative, but the SERVER
    // clamps to "now" (a future date would dodge the retention sweep — "immortal trash"); past
    // timestamps are legitimate (offline trash). Only DELETE/batch changes trash state, not PUT.
    deleted_at: z.number().int().optional().nullable(),
    trashed_batch_id: z.string().uuid().optional().nullable(),
    // DELETED discriminator: purged_at != null → tombstone. The server sets it
    // on hard delete and returns it on pull; the client never sends it (it is ignored on upsert).
    purged_at: z.number().int().optional().nullable(),
    // File-only plaintext refs (null for a note or folder). Visible to the server so it can validate
    // uploads and ref-count chunk sets for GC. Content and name stay encrypted in
    // the payload.
    chunk_set_id: z.string().uuid().optional().nullable(),
    chunk_count: z.number().int().nonnegative().optional().nullable(),
    ciphertext_size: z.number().int().nonnegative().optional().nullable(),
    // Server-authoritative timestamps. Optional on the wire because the client never
    // sends them on upsert — the server sets them and sends them back.
    created_at: z.number().int().optional().nullable(),
    updated_at: z.number().int().optional().nullable(),
});

/**
 * Cross-field consistency of the four crypto fields: either ALL are null (tombstone
 * or soft-delete) or ALL are present (live item). A mixed state — payload null with item_key set,
 * say — is invalid; otherwise partially deleted rows pass validation and untie the payload from
 * its key.
 */
const cryptoFieldsConsistent = (
    v: {
        encrypted_payload?: string | null;
        payload_nonce?: string | null;
        encrypted_item_key?: string | null;
        item_key_nonce?: string | null;
    },
    ctx: zod.RefinementCtx,
) => {
    const fields = [v.encrypted_payload, v.payload_nonce, v.encrypted_item_key, v.item_key_nonce];
    const nullCount = fields.filter((f) => f == null).length;
    if (nullCount !== 0 && nullCount !== 4) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "crypto_fields_must_be_all_null_or_all_present",
        });
    }
};

/** File plaintext refs are meaningful only on `type: "file"`. Null/omitted is fine on any type. */
const fileFieldsOnlyOnFiles = (
    v: {
        type?: "note" | "folder" | "file";
        chunk_set_id?: string | null;
        chunk_count?: number | null;
        ciphertext_size?: number | null;
    },
    ctx: zod.RefinementCtx,
) => {
    if (v.type === "file") return;
    if (v.chunk_set_id != null || v.chunk_count != null || v.ciphertext_size != null) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "file_fields_only_allowed_on_file_items",
        });
    }
};

export const EncryptedItemSchema =
    EncryptedItemObject.superRefine(cryptoFieldsConsistent).superRefine(fileFieldsOnlyOnFiles);

/** The wire format of an item — one source of truth for both the client (IDB mirror) and the server. */
export type EncryptedItem = zod.infer<typeof EncryptedItemObject>;

export const CreateItemSchema = EncryptedItemObject.omit({ version: true })
    .superRefine(cryptoFieldsConsistent)
    .superRefine(fileFieldsOnlyOnFiles);

export const UpdateItemSchema = EncryptedItemObject.partial().required({
    version: true,
});

/**
 * One entry in `delete_ids` (hard delete / purge). Two forms:
 *  - a bare `uuid` string — an unconditional purge (legacy, and bulk "empty trash" with no
 *    optimistic lock).
 *  - `{ id, version }` — a version-guarded purge: the server purges ONLY if `version` matches the
 *    current one. This stops a stale delete from one device destroying work restored or edited on
 *    another.
 */
export const DeleteIdSchema = z.union([
    z.string().uuid(),
    z.object({ id: z.string().uuid(), version: z.number().int().min(1) }),
]);
export type DeleteId = zod.infer<typeof DeleteIdSchema>;

export const ChangePasswordSchema = z.object({
    // The same strength as Register/Login — base64 alphabet + exact length (previously just
    // .length()).
    current_auth_key: z.string().regex(B64_CHARS).length(44),
    new_auth_key: z.string().regex(B64_CHARS).length(44),
    new_kdf_salt: z.string().regex(B64_CHARS).length(24),
    new_kdf_params: KdfParamsSchema,
    new_encrypted_vault_key: z.string().regex(B64_CHARS).length(64), // base64 48B
    new_vault_key_nonce: z.string().regex(/^[A-Za-z0-9+/]{32}$/), // base64 24B, unpadded
});

export type ChangePasswordRequest = zod.infer<typeof ChangePasswordSchema>;

// ── Version History schemas ────────────────────────────────────────────────

export const HistorySnapshotSchema = z.object({
    id: z.string().uuid(),
    item_id: z.string().uuid(),
    encrypted_payload: z.string().max(MAX_ENCRYPTED_PAYLOAD_B64), // base64
    payload_nonce: nonceB64Schema, // base64 24B
    encrypted_item_key: z.string(), // base64
    item_key_nonce: nonceB64Schema, // base64 24B
    item_version_at_snapshot: z.number().int().min(1),
    snapshot_number: z.number().int().min(1).optional(), // computed via ROW_NUMBER in the API
    created_at: z.number().int(),
});

export type HistorySnapshot = zod.infer<typeof HistorySnapshotSchema>;

export const CreateHistorySnapshotSchema = HistorySnapshotSchema.omit({
    id: true,
    created_at: true,
});

export type CreateHistorySnapshot = zod.infer<typeof CreateHistorySnapshotSchema>;

// ── Storage and quotas ─────────────────────────────────────────────────────

export const MeStorageResponseDto = z.object({
    storage_quota: z.number().int(),
    max_file_size: z.number().int(),
    total_items: z.number().int(), // from COUNT(*) in the database
    /** User-facing plan label; `null` on a self-host. The raw plan key and `is_paid_plan`
     *  **are no longer exposed** — the vault has no need for a taxonomy of plans. */
    plan_label: z.string().nullable(),
    /** The concrete share TTL allowed — the client filters the options rather than deriving them from the plan. */
    max_share_ttl_sec: z.number().int().nonnegative(),
    breakdown: z.object({
        files_bytes: z.number().int(),
        items_bytes: z.number().int(),
        history_bytes: z.number().int(),
        trashed_bytes: z.number().int(),
        total_used: z.number().int(),
    }),
});
export type MeStorageResponseDtoType = zod.infer<typeof MeStorageResponseDto>;

// ── Plans and quotas ─────────────────────────────────────────────────────────

export const BACKSTOP_FACTOR = 1.2;

export const ITEM_LIMITS = {
    MAX_ITEMS_COUNT: 100_000,
} as const;

// ── Share-link limits ────────────────────────────────────────────────────────

export const ShareAttachmentSchema = z.object({
    file_id: z.string().uuid(),
    wrapped_item_key: z.string().regex(B64_CHARS).length(64), // 48B (32B key + 16B tag) b64
    item_key_nonce: nonceB64Schema,
});

export const CreateShareSchema = z
    .object({
        id: z.string().uuid(),
        source_item_id: z.string().uuid(),
        wrapped_item_key: z.string().regex(B64_CHARS).length(64), // 48B (32B key + 16B tag) b64
        item_key_nonce: nonceB64Schema,
        expires_in_sec: z.number().int().positive().nullable(),
        max_views: z.literal(1).nullable(),
        // HKDF(linkKey) proof — the server stores only the hash; prevents a burn without the fragment key.
        view_proof: z.string().regex(B64_CHARS).length(44),
        share_auth_key: z.string().regex(B64_CHARS).length(44).nullable(),
        share_kdf_salt: z.string().regex(B64_CHARS).length(24).nullable(),
        share_kdf_params: KdfParamsSchema.nullable(),
        attachments: z.array(ShareAttachmentSchema).max(20).optional(),
    })
    .superRefine((data, ctx) => {
        const pwdFields = [
            data.share_auth_key,
            data.share_kdf_salt,
            data.share_kdf_params,
        ] as const;
        const anySet = pwdFields.some((f) => f != null);
        const allSet = pwdFields.every((f) => f != null);
        if (anySet && !allSet) {
            ctx.addIssue({
                code: "custom",
                message: "share password fields must be all set or all null",
                path: ["share_auth_key"],
            });
        }
    });

export type CreateShareRequest = zod.infer<typeof CreateShareSchema>;

export const ViewShareSchema = z.object({
    /** The same HKDF proof as on create — required when the share has a view_proof_hash. */
    view_proof: z.string().regex(B64_CHARS).length(44).optional(),
    share_auth_key: z.string().regex(B64_CHARS).length(44).optional(),
});

export type ViewShareRequest = zod.infer<typeof ViewShareSchema>;

// ── File manager limits and upload schema ──────────────────────────────────

/** Batch sync limits. MAX_BATCH_BYTES must stay below the API bodyLimit (30 MB). */
export const SYNC_LIMITS = {
    MAX_BATCH_BYTES: 8 * 1024 * 1024, // 8 MiB per batch
    /** Maximum items in one paginated `GET /items` page. */
    PULL_PAGE_SIZE: 1000,
    /** Maximum UTF-8 bytes in the JSON body of one pull page — the same 8 MiB as a batch. */
    PULL_PAGE_BYTES: 8 * 1024 * 1024,
} as const;

/**
 * Query for `GET /items`. `limit` is required: every pull is paged (`next_cursor` until it is null),
 * so no request makes the server hold a user's whole item set in memory.
 */
export const PullItemsQuerySchema = z.object({
    since: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(SYNC_LIMITS.PULL_PAGE_SIZE),
    cursor: z.string().min(1).max(4096).optional(),
});
export type PullItemsQuery = zod.infer<typeof PullItemsQuerySchema>;

/**
 * An opaque cursor: the keyset `(updated_at, id)` for both sequences plus the `server_time` of the
 * first page. The client does not interpret it — it only returns what it was given. `updated_at`
 * alone is not unique (a restore commit sets an identical timestamp on up to 100k rows).
 */
export const PullCursorPayloadSchema = z
    .object({
        v: z.literal(1),
        /**
         * The `server_time` (ms) issued with the first page — echoed through the whole sequence.
         */
        st: z.number().int().nonnegative(),
        /** Item keyset: the last `updated_at` (seconds). Required until `idone` is true. */
        it: z.number().int().optional(),
        iid: z.string().uuid().optional(),
        idone: z.boolean(),
        /** `sync_deleted_log` keyset: the last `deleted_at` (seconds). */
        dt: z.number().int().optional(),
        did: z.string().uuid().optional(),
        ddone: z.boolean(),
    })
    .superRefine((data, ctx) => {
        if (!data.idone && (data.it === undefined || data.iid === undefined)) {
            ctx.addIssue({
                code: "custom",
                message: "item keyset required until items are exhausted",
                path: ["iid"],
            });
        }
    });
export type PullCursorPayload = zod.infer<typeof PullCursorPayloadSchema>;

export const PullDeletedEntrySchema = z.object({
    id: z.string().uuid(),
    deleted_at: z.number().int(),
});

export const PullItemsResponseSchema = z.object({
    items: z.array(EncryptedItemSchema),
    deleted: z.array(PullDeletedEntrySchema),
    server_time: z.number().int().nonnegative(),
    server_time_iso: z.string(),
    next_cursor: z.string().nullable().optional(),
});
export type PullItemsResponse = zod.infer<typeof PullItemsResponseSchema>;

function utf8ToB64url(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlToBytes(s: string): Uint8Array | null {
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
    let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    try {
        const binary = atob(b64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

/** Encodes the keyset cursor as base64url (query-safe; no `+` or `/`). */
export function encodePullCursor(payload: PullCursorPayload): string {
    const parsed = PullCursorPayloadSchema.parse(payload);
    return utf8ToB64url(new TextEncoder().encode(JSON.stringify(parsed)));
}

/**
 * Decodes the cursor. Corrupt or invented input → `null` (the route answers 400 rather than
 * silently resetting to since=0).
 */
export function decodePullCursor(raw: string): PullCursorPayload | null {
    const bytes = b64urlToBytes(raw);
    if (!bytes) return null;
    try {
        const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const parsed = PullCursorPayloadSchema.safeParse(json);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Limits of the transactional restore wizard. The values live here, not in the route. */
export const RESTORE_LIMITS = {
    /** Peak quota overshoot, allowed only while a restore session is open. */
    PEAK_FACTOR: 2,
    /** Idle TTL; `POST /restore/sessions/:id/ping` refreshes it. */
    TTL_SECONDS: 30 * 60,
    /** Maximum staged items per POST /restore/sessions/:id/items. */
    MAX_STAGED_ITEMS_PER_REQUEST: 1000,
    /** Byte cap of a single staging request — the same as a sync batch. */
    MAX_STAGED_BYTES_PER_REQUEST: SYNC_LIMITS.MAX_BATCH_BYTES,
    /** Maximum parallel blob upload sessions within one restore session. */
    MAX_PARALLEL_STAGING_UPLOADS: 16,
    /**
     * Chunk size of the bulk INSERT … ON CONFLICT during commit (measured by the bulk-upsert pass
     * of `server/scripts/measure-restore-commit.ts`).
     */
    COMMIT_CHUNK_SIZE: 1000,
    /** SET LOCAL statement_timeout inside the commit transaction (a belt for production disks). */
    COMMIT_STATEMENT_TIMEOUT_MS: 30_000,
    /**
     * The last remap generation tried for a purged id whose earlier remaps are purged too;
     * beyond it the preflight blocks with `remap_exhausted`.
     */
    MAX_REMAP_GENERATION: 8,
} as const;

export const RESTORE_MODES = ["skip_existing", "overwrite_all"] as const;
export type RestoreMode = (typeof RESTORE_MODES)[number];

/** One manifest entry — only metadata the server already sees; no plaintext. */
export const RestoreManifestItemSchema = z.object({
    id: z.string().uuid(),
    type: z.enum(["note", "folder", "file"]),
    parent_id: z.string().uuid().nullable(),
    /** Ciphertext + AEAD tag, not the plaintext size. */
    byte_size: z.number().int().min(0),
});
export type RestoreManifestItem = zod.infer<typeof RestoreManifestItemSchema>;

/** Body for POST /restore/sessions (phase 1 preflight). */
export const RestoreSessionCreateSchema = z.object({
    backup_hash: z.string().min(1).max(128),
    manifest: z.array(RestoreManifestItemSchema).min(1).max(ITEM_LIMITS.MAX_ITEMS_COUNT),
    mode: z.enum(RESTORE_MODES),
});
export type RestoreSessionCreateRequest = zod.infer<typeof RestoreSessionCreateSchema>;

/**
 * One staged item: the wire item, plus — when the item comes back under a new id because the server
 * purged its original — that original manifest id. The server recomputes the remap from
 * `backup_hash` and accepts the new id only if it matches; the field is not stored.
 */
const RestoreStagedItemObject = EncryptedItemObject.extend({
    remapped_from: z.string().uuid().optional(),
});
export const RestoreStagedItemSchema =
    RestoreStagedItemObject.superRefine(cryptoFieldsConsistent).superRefine(fileFieldsOnlyOnFiles);
export type RestoreStagedItem = zod.infer<typeof RestoreStagedItemObject>;

/** Body for POST /restore/sessions/:id/items — staged ciphertext, idempotent by id. */
export const RestoreSessionItemsSchema = z.object({
    items: z.array(RestoreStagedItemSchema).min(1).max(RESTORE_LIMITS.MAX_STAGED_ITEMS_PER_REQUEST),
});
export type RestoreSessionItemsRequest = zod.infer<typeof RestoreSessionItemsSchema>;

/** Phase 3 / phase 4 — empty body; the state lives on the session. */
export const RestoreVerifySchema = z.object({}).strict().optional();
export const RestoreCommitSchema = z.object({}).strict().optional();

export const FILE_LIMITS = {
    /**
     * DEFAULT per-user max file size (plaintext). The real limit lives in `users.max_file_size`
     * (per plan — you get what you pay for); this is the default for new users and the client-side
     * fallback until the limit is fetched from the server (GET /me/storage).
     */
    // 50 MB. It stands here as the **open-core default and client fallback** until the server
    // answers — `shared` is imported by the client too, so it must not know about plans.
    MAX_FILE_SIZE: 50 * 1024 * 1024,
    /**
     * Absolute ceiling on per-file size regardless of plan — a bound for the static Zod schemas
     * (the per-user check lives in the POST /uploads route) and the source for MAX_CHUNKS.
     */
    MAX_FILE_SIZE_CAP: 12 * 1024 * 1024 * 1024, // 12 GiB plaintext (multipart)
    CHUNK_SIZE: 5 * 1024 * 1024, // 5 MiB plaintext per chunk
    AEAD_TAG: 16, // XChaCha20-Poly1305 tag bytes
    /** Maximum ciphertext bytes accepted for one chunk (plaintext chunk + tag). */
    MAX_CHUNK_CIPHERTEXT: 5 * 1024 * 1024 + 16,
    /** Ceil(MAX_FILE_SIZE_CAP / CHUNK_SIZE) — upper bound on chunks per file. */
    MAX_CHUNKS: 2458,
    /** Maximum indices per POST /uploads/:id/urls (lazy mint). */
    MINT_URLS_MAX_INDICES: 32,
    /** Lifetime of the presigned PUT signature (seconds). */
    PRESIGNED_PUT_EXPIRES_SEC: 300,
    /** Limit of concurrent upload sessions per user (anti-abuse). */
    MAX_CONCURRENT_UPLOAD_SESSIONS: 5,
    /** Hard limit on the total number of file items per user (anti-abuse). */
    MAX_FILE_COUNT: 50_000,
    /** Maximum upsert/delete_ids entries per POST /items/batch (bulk cap). */
    MAX_BATCH_OPS: 1000,
} as const;

export const BatchItemsSchema = z.object({
    upsert: z.array(EncryptedItemSchema).max(FILE_LIMITS.MAX_BATCH_OPS),
    delete_ids: z.array(DeleteIdSchema).max(FILE_LIMITS.MAX_BATCH_OPS),
});

/** Body for POST /uploads — opens an upload session. */
export const OpenUploadSchema = z
    .object({
        expected_chunks: z.number().int().min(1).max(FILE_LIMITS.MAX_CHUNKS),
        // Σ of the ciphertext bytes the client will upload; bounded by the absolute cap — the real
        // per-plan limit (users.max_file_size) is checked in the route, not here.
        total_size: z
            .number()
            .int()
            .min(1)
            .max(FILE_LIMITS.MAX_FILE_SIZE_CAP + FILE_LIMITS.MAX_CHUNKS * FILE_LIMITS.AEAD_TAG),
        // Per-chunk ciphertext sizes: the server seals them into the presigned PUT URLs as
        // ContentLength → S3 rejects an upload that exceeds the declared size.
        // Must hold: length === expected_chunks and Σ === total_size.
        chunk_sizes: z
            .array(z.number().int().min(1).max(FILE_LIMITS.MAX_CHUNK_CIPHERTEXT))
            .min(1)
            .max(FILE_LIMITS.MAX_CHUNKS),
        /** Blob staging through the restore wizard; without it, an ordinary upload. */
        restore_session_id: z.string().uuid().optional(),
    })
    .superRefine((v, ctx) => {
        if (v.chunk_sizes.length !== v.expected_chunks) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "chunk_sizes_length_must_equal_expected_chunks",
                path: ["chunk_sizes"],
            });
            return;
        }
        const sum = v.chunk_sizes.reduce((a, b) => a + b, 0);
        if (sum !== v.total_size) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "chunk_sizes_sum_must_equal_total_size",
                path: ["chunk_sizes"],
            });
        }
    });

/** Body for POST /uploads/:chunkSetId/urls — lazy mint of presigned PUT URLs. */
export const MintUploadUrlsSchema = z.object({
    indices: z
        .array(
            z
                .number()
                .int()
                .min(0)
                .max(FILE_LIMITS.MAX_CHUNKS - 1),
        )
        .min(1)
        .max(FILE_LIMITS.MINT_URLS_MAX_INDICES),
});
