import { describe, expect, it } from "vitest";
import {
    BatchItemsSchema,
    ChangePasswordSchema,
    CreateItemSchema,
    decodePullCursor,
    EncryptedItemSchema,
    encodePullCursor,
    FILE_LIMITS,
    LoginSchema,
    OpenUploadSchema,
    PullCursorPayloadSchema,
    PullItemsQuerySchema,
    RESTORE_LIMITS,
    RestoreCommitSchema,
    RestoreSessionCreateSchema,
    RestoreSessionItemsSchema,
    RestoreVerifySchema,
    SYNC_LIMITS,
    VaultCreateSchema,
    VerifyEmailSchema,
} from "./schemas";

// Valid input reused across the tests
const validAuthKey = "A".repeat(44); // base64 32B = 44 characters
const validSalt = "B".repeat(24); // base64 16B = 24 characters
const validKdfParams = { m: 65536, t: 3, p: 4 };
const validUuid = "018e1234-5678-7abc-8def-000000000001";

describe("VerifyEmailSchema", () => {
    it("accepts a non-empty token", () => {
        expect(VerifyEmailSchema.safeParse({ token: "abc123" }).success).toBe(true);
    });

    it("rejects an empty token", () => {
        expect(VerifyEmailSchema.safeParse({ token: "" }).success).toBe(false);
    });

    it("rejects a token longer than 128 characters", () => {
        expect(VerifyEmailSchema.safeParse({ token: "a".repeat(129) }).success).toBe(false);
    });
});

// The KDF floors and the exact base64 lengths hold for vault material no matter which route
// receives it, so they are checked against `VaultCreateSchema`.
describe("VaultCreateSchema", () => {
    const valid = {
        email: "user@example.com",
        auth_key: validAuthKey,
        kdf_salt: validSalt,
        kdf_params: validKdfParams,
        encrypted_vault_key: "A".repeat(64), // base64 48B ciphertext
        vault_key_nonce: "B".repeat(32), // base64 24B nonce, unpadded
    };

    it("accepts valid input", () => {
        expect(VaultCreateSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects an email without an @", () => {
        expect(VaultCreateSchema.safeParse({ ...valid, email: "notanemail" }).success).toBe(false);
    });

    it("rejects an auth_key shorter than 44 characters", () => {
        expect(VaultCreateSchema.safeParse({ ...valid, auth_key: "A".repeat(43) }).success).toBe(
            false,
        );
    });

    it("rejects an auth_key longer than 44 characters", () => {
        expect(VaultCreateSchema.safeParse({ ...valid, auth_key: "A".repeat(45) }).success).toBe(
            false,
        );
    });

    it("rejects an auth_key with disallowed characters", () => {
        expect(VaultCreateSchema.safeParse({ ...valid, auth_key: "!".repeat(44) }).success).toBe(
            false,
        );
    });

    it("rejects a kdf_salt that is not exactly 24 characters", () => {
        expect(VaultCreateSchema.safeParse({ ...valid, kdf_salt: "B".repeat(20) }).success).toBe(
            false,
        );
    });

    it("rejects kdf_params.m below the minimum (1024)", () => {
        expect(
            VaultCreateSchema.safeParse({ ...valid, kdf_params: { ...validKdfParams, m: 512 } })
                .success,
        ).toBe(false);
    });

    it("rejects kdf_params.m above the maximum (1048576)", () => {
        expect(
            VaultCreateSchema.safeParse({
                ...valid,
                kdf_params: { ...validKdfParams, m: 2_000_000 },
            }).success,
        ).toBe(false);
    });

    it("rejects kdf_params.t outside the range [1, 10]", () => {
        expect(
            VaultCreateSchema.safeParse({ ...valid, kdf_params: { ...validKdfParams, t: 0 } })
                .success,
        ).toBe(false);
        expect(
            VaultCreateSchema.safeParse({ ...valid, kdf_params: { ...validKdfParams, t: 11 } })
                .success,
        ).toBe(false);
    });

    it("rejects kdf_params.p outside the range [1, 16]", () => {
        expect(
            VaultCreateSchema.safeParse({ ...valid, kdf_params: { ...validKdfParams, p: 0 } })
                .success,
        ).toBe(false);
        expect(
            VaultCreateSchema.safeParse({ ...valid, kdf_params: { ...validKdfParams, p: 17 } })
                .success,
        ).toBe(false);
    });
});

describe("LoginSchema", () => {
    const valid = { email: "user@example.com", auth_key: validAuthKey };

    it("accepts valid input", () => {
        expect(LoginSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects a short auth_key", () => {
        expect(LoginSchema.safeParse({ ...valid, auth_key: "short" }).success).toBe(false);
    });

    it("rejects an invalid email", () => {
        expect(LoginSchema.safeParse({ ...valid, email: "notvalid" }).success).toBe(false);
    });
});

describe("EncryptedItemSchema", () => {
    const valid = {
        id: validUuid,
        type: "note" as const,
        parent_id: null,
        encrypted_payload: "abc123",
        payload_nonce: "A".repeat(32),
        encrypted_item_key: "C".repeat(64),
        item_key_nonce: "B".repeat(32),
        version: 1,
        sort_order: "abc",
    };

    it("accepts the note/folder/file type", () => {
        for (const type of ["note", "folder", "file"] as const) {
            expect(EncryptedItemSchema.safeParse({ ...valid, type }).success).toBe(true);
        }
    });

    it("rejects an unknown type", () => {
        expect(EncryptedItemSchema.safeParse({ ...valid, type: "unknown" }).success).toBe(false);
    });

    it("allows ALL 4 crypto fields to be null (tombstone)", () => {
        expect(
            EncryptedItemSchema.safeParse({
                ...valid,
                encrypted_payload: null,
                payload_nonce: null,
                encrypted_item_key: null,
                item_key_nonce: null,
            }).success,
        ).toBe(true);
    });

    it("rejects a mixed crypto state (payload null, item_key set)", () => {
        expect(
            EncryptedItemSchema.safeParse({
                ...valid,
                encrypted_payload: null,
                payload_nonce: null,
                // encrypted_item_key + item_key_nonce stay populated → mixed → invalid
            }).success,
        ).toBe(false);
    });

    it("rejects an encrypted_payload larger than ~10 MiB (base64)", () => {
        const tooBig = "A".repeat(Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4);
        expect(EncryptedItemSchema.safeParse({ ...valid, encrypted_payload: tooBig }).success).toBe(
            false,
        );
    });

    it("rejects a payload_nonce with non-base64 characters of the same length", () => {
        expect(
            EncryptedItemSchema.safeParse({ ...valid, payload_nonce: "!".repeat(32) }).success,
        ).toBe(false);
    });

    it("rejects a payload_nonce that is not exactly 32 characters", () => {
        expect(
            EncryptedItemSchema.safeParse({ ...valid, payload_nonce: "A".repeat(31) }).success,
        ).toBe(false);
        expect(
            EncryptedItemSchema.safeParse({ ...valid, payload_nonce: "A".repeat(33) }).success,
        ).toBe(false);
    });

    it("rejects an empty sort_order", () => {
        expect(EncryptedItemSchema.safeParse({ ...valid, sort_order: "" }).success).toBe(false);
    });

    it("rejects a sort_order longer than 256 characters", () => {
        expect(
            EncryptedItemSchema.safeParse({ ...valid, sort_order: "a".repeat(257) }).success,
        ).toBe(false);
    });

    it("rejects version < 1", () => {
        expect(EncryptedItemSchema.safeParse({ ...valid, version: 0 }).success).toBe(false);
    });

    it("EncryptedItemSchema rejects a malformed item key", () => {
        expect(
            EncryptedItemSchema.safeParse({ ...valid, encrypted_item_key: "!".repeat(64) }).success,
        ).toBe(false);
        expect(
            EncryptedItemSchema.safeParse({ ...valid, encrypted_item_key: "K".repeat(63) }).success,
        ).toBe(false);
        expect(
            EncryptedItemSchema.safeParse({ ...valid, encrypted_item_key: "K".repeat(65) }).success,
        ).toBe(false);
    });

    it("rejects chunk_set_id / chunk_count / ciphertext_size on a note", () => {
        expect(
            EncryptedItemSchema.safeParse({ ...valid, type: "note", chunk_set_id: validUuid })
                .success,
        ).toBe(false);
        expect(
            EncryptedItemSchema.safeParse({ ...valid, type: "note", chunk_count: 1 }).success,
        ).toBe(false);
        expect(
            EncryptedItemSchema.safeParse({ ...valid, type: "folder", ciphertext_size: 19 })
                .success,
        ).toBe(false);
    });

    it("allows file fields on a file item and null/omitted file fields on a note", () => {
        expect(
            EncryptedItemSchema.safeParse({
                ...valid,
                type: "file",
                chunk_set_id: validUuid,
                chunk_count: 1,
                ciphertext_size: 19,
            }).success,
        ).toBe(true);
        expect(
            EncryptedItemSchema.safeParse({
                ...valid,
                type: "note",
                chunk_set_id: null,
                chunk_count: null,
                ciphertext_size: null,
            }).success,
        ).toBe(true);
        expect(EncryptedItemSchema.safeParse(valid).success).toBe(true);
    });

    it("CreateItemSchema also rejects file fields on a non-file", () => {
        expect(
            CreateItemSchema.safeParse({ ...valid, type: "note", chunk_set_id: validUuid }).success,
        ).toBe(false);
        expect(CreateItemSchema.safeParse(valid).success).toBe(true);
    });
});

describe("BatchItemsSchema", () => {
    const validItem = {
        id: validUuid,
        type: "note" as const,
        parent_id: null,
        encrypted_payload: "x",
        payload_nonce: "A".repeat(32),
        encrypted_item_key: "C".repeat(64),
        item_key_nonce: "B".repeat(32),
        version: 1,
        sort_order: "1",
    };

    it("accepts a valid batch", () => {
        expect(BatchItemsSchema.safeParse({ upsert: [validItem], delete_ids: [] }).success).toBe(
            true,
        );
    });

    it("rejects an upsert array with more than 1000 elements", () => {
        const tooMany = Array(1001).fill(validItem);
        expect(BatchItemsSchema.safeParse({ upsert: tooMany, delete_ids: [] }).success).toBe(false);
    });

    it("rejects a delete_ids array with more than 1000 elements", () => {
        const tooMany = Array(1001).fill(validUuid);
        expect(BatchItemsSchema.safeParse({ upsert: [], delete_ids: tooMany }).success).toBe(false);
    });
});

describe("FILE_LIMITS consistency", () => {
    it("CHUNK_SIZE × MAX_CHUNKS >= MAX_FILE_SIZE_CAP", () => {
        expect(FILE_LIMITS.CHUNK_SIZE * FILE_LIMITS.MAX_CHUNKS).toBeGreaterThanOrEqual(
            FILE_LIMITS.MAX_FILE_SIZE_CAP,
        );
    });

    it("MAX_CHUNK_CIPHERTEXT = CHUNK_SIZE + AEAD_TAG", () => {
        expect(FILE_LIMITS.MAX_CHUNK_CIPHERTEXT).toBe(
            FILE_LIMITS.CHUNK_SIZE + FILE_LIMITS.AEAD_TAG,
        );
    });

    it("PRESIGNED_PUT_EXPIRES_SEC is 300 (short enough that abort+GC can re-sweep before URLs die)", () => {
        expect(FILE_LIMITS.PRESIGNED_PUT_EXPIRES_SEC).toBe(300);
    });

    it("BatchItemsSchema uses MAX_BATCH_OPS for both fields", () => {
        expect(FILE_LIMITS.MAX_BATCH_OPS).toBe(1000);
        const atCap = {
            upsert: Array.from({ length: FILE_LIMITS.MAX_BATCH_OPS }, () => ({
                id: "00000000-0000-4000-8000-000000000001",
                type: "note" as const,
                parent_id: null,
                encrypted_payload: "cGF5bG9hZA==",
                payload_nonce: "A".repeat(32),
                encrypted_item_key: "C".repeat(64),
                item_key_nonce: "B".repeat(32),
                sort_order: "m",
                version: 1,
            })),
            delete_ids: Array.from(
                { length: FILE_LIMITS.MAX_BATCH_OPS },
                () => "00000000-0000-4000-8000-000000000002",
            ),
        };
        expect(BatchItemsSchema.safeParse(atCap).success).toBe(true);
        expect(
            BatchItemsSchema.safeParse({
                ...atCap,
                delete_ids: [...atCap.delete_ids, "00000000-0000-4000-8000-000000000003"],
            }).success,
        ).toBe(false);
    });
});

describe("ChangePasswordSchema", () => {
    const valid = {
        current_auth_key: validAuthKey,
        new_auth_key: validAuthKey,
        new_kdf_salt: validSalt,
        new_kdf_params: validKdfParams,
        new_encrypted_vault_key: "V".repeat(64), // base64 48B
        new_vault_key_nonce: "N".repeat(32), // base64 24B, unpadded
    };

    it("accepts valid input", () => {
        expect(ChangePasswordSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects a new_auth_key of the wrong length", () => {
        expect(ChangePasswordSchema.safeParse({ ...valid, new_auth_key: "short" }).success).toBe(
            false,
        );
    });

    it("rejects a new_kdf_salt with non-base64 characters of the exact length", () => {
        expect(
            ChangePasswordSchema.safeParse({ ...valid, new_kdf_salt: "!".repeat(24) }).success,
        ).toBe(false);
    });

    it("rejects a new_encrypted_vault_key of the wrong length", () => {
        expect(
            ChangePasswordSchema.safeParse({ ...valid, new_encrypted_vault_key: "V".repeat(63) })
                .success,
        ).toBe(false);
    });

    it("rejects a new_vault_key_nonce of the wrong length", () => {
        expect(
            ChangePasswordSchema.safeParse({ ...valid, new_vault_key_nonce: "N".repeat(33) })
                .success,
        ).toBe(false);
    });
});

describe("RESTORE_LIMITS", () => {
    it("PEAK_FACTOR is strictly greater than BACKSTOP_FACTOR", async () => {
        const { BACKSTOP_FACTOR } = await import("./schemas");
        expect(RESTORE_LIMITS.PEAK_FACTOR).toBeGreaterThan(BACKSTOP_FACTOR);
        expect(RESTORE_LIMITS.PEAK_FACTOR).toBe(2);
    });

    it("staging limits are not hardcoded in the route — they live in shared", () => {
        expect(RESTORE_LIMITS.TTL_SECONDS).toBeGreaterThan(0);
        expect(RESTORE_LIMITS.MAX_STAGED_ITEMS_PER_REQUEST).toBeGreaterThan(0);
        expect(RESTORE_LIMITS.MAX_STAGED_BYTES_PER_REQUEST).toBeGreaterThan(0);
        expect(RESTORE_LIMITS.MAX_PARALLEL_STAGING_UPLOADS).toBeGreaterThan(0);
        expect(RESTORE_LIMITS.COMMIT_CHUNK_SIZE).toBe(1000);
    });
});

describe("RestoreSessionCreateSchema", () => {
    const validManifestItem = {
        id: validUuid,
        type: "note" as const,
        parent_id: null,
        byte_size: 32,
    };

    it("accepts skip_existing and overwrite_all", () => {
        for (const mode of ["skip_existing", "overwrite_all"] as const) {
            expect(
                RestoreSessionCreateSchema.safeParse({
                    backup_hash: "a".repeat(64),
                    manifest: [validManifestItem],
                    mode,
                }).success,
            ).toBe(true);
        }
    });

    it("rejects plaintext fields (only id/type/parent_id/byte_size)", () => {
        const parsed = RestoreSessionCreateSchema.safeParse({
            backup_hash: "a".repeat(64),
            manifest: [{ ...validManifestItem, title: "secret" }],
            mode: "skip_existing",
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect("title" in parsed.data.manifest[0]!).toBe(false);
        }
    });

    it("rejects an unknown mode and a negative byte_size", () => {
        expect(
            RestoreSessionCreateSchema.safeParse({
                backup_hash: "a".repeat(64),
                manifest: [validManifestItem],
                mode: "merge",
            }).success,
        ).toBe(false);
        expect(
            RestoreSessionCreateSchema.safeParse({
                backup_hash: "a".repeat(64),
                manifest: [{ ...validManifestItem, byte_size: -1 }],
                mode: "skip_existing",
            }).success,
        ).toBe(false);
    });
});

describe("RestoreSessionItemsSchema", () => {
    const validItem = {
        id: validUuid,
        type: "note" as const,
        parent_id: null,
        encrypted_payload: "cGF5bG9hZA==",
        payload_nonce: "A".repeat(32),
        encrypted_item_key: "C".repeat(64),
        item_key_nonce: "B".repeat(32),
        sort_order: "m",
        version: 1,
    };

    it("accepts a batch below MAX_STAGED_ITEMS_PER_REQUEST", () => {
        expect(RestoreSessionItemsSchema.safeParse({ items: [validItem] }).success).toBe(true);
    });

    it("rejects more than MAX_STAGED_ITEMS_PER_REQUEST items", () => {
        const tooMany = Array.from(
            { length: RESTORE_LIMITS.MAX_STAGED_ITEMS_PER_REQUEST + 1 },
            () => validItem,
        );
        expect(RestoreSessionItemsSchema.safeParse({ items: tooMany }).success).toBe(false);
    });
});

describe("RestoreVerifySchema / RestoreCommitSchema", () => {
    it("accepts an empty body", () => {
        expect(RestoreVerifySchema.safeParse({}).success).toBe(true);
        expect(RestoreCommitSchema.safeParse({}).success).toBe(true);
        expect(RestoreVerifySchema.safeParse(undefined).success).toBe(true);
        expect(RestoreCommitSchema.safeParse(undefined).success).toBe(true);
    });

    it("rejects unknown fields", () => {
        expect(RestoreVerifySchema.safeParse({ foo: 1 }).success).toBe(false);
        expect(RestoreCommitSchema.safeParse({ foo: 1 }).success).toBe(false);
    });
});

describe("OpenUploadSchema restore_session_id", () => {
    const base = {
        expected_chunks: 1,
        total_size: 64,
        chunk_sizes: [64],
    };

    it("accepts a request without restore_session_id (an ordinary upload)", () => {
        expect(OpenUploadSchema.safeParse(base).success).toBe(true);
    });

    it("accepts the optional restore_session_id as a uuid", () => {
        expect(OpenUploadSchema.safeParse({ ...base, restore_session_id: validUuid }).success).toBe(
            true,
        );
        expect(
            OpenUploadSchema.safeParse({ ...base, restore_session_id: "not-a-uuid" }).success,
        ).toBe(false);
    });
});

describe("pull cursor codec", () => {
    const itemId = "018e1234-5678-7abc-8def-000000000001";
    const itemId2 = "018e1234-5678-7abc-8def-000000000002";

    it("roundtrips a compound (updated_at, id) cursor including server_time", () => {
        const payload = {
            v: 1 as const,
            st: 1_700_000_000_000,
            it: 1_700_000_000,
            iid: itemId,
            idone: false,
            ddone: false,
        };
        const encoded = encodePullCursor(payload);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(encoded).not.toMatch(/[+/=]/);
        expect(decodePullCursor(encoded)).toEqual(payload);
    });

    it("rejects a timestamp-only cursor while items remain", () => {
        const parsed = PullCursorPayloadSchema.safeParse({
            v: 1,
            st: 1,
            it: 1_700_000_000,
            idone: false,
            ddone: true,
        });
        expect(parsed.success).toBe(false);
        expect(decodePullCursor(encodeURIComponent("not-a-cursor"))).toBeNull();
        expect(decodePullCursor("%%%")).toBeNull();
        expect(decodePullCursor("not-valid")).toBeNull();
    });

    it("preserves two distinct ids that share updated_at", () => {
        const a = encodePullCursor({
            v: 1,
            st: 1,
            it: 42,
            iid: itemId,
            idone: false,
            ddone: true,
        });
        const b = encodePullCursor({
            v: 1,
            st: 1,
            it: 42,
            iid: itemId2,
            idone: false,
            ddone: true,
        });
        expect(a).not.toBe(b);
        expect(decodePullCursor(a)?.iid).toBe(itemId);
        expect(decodePullCursor(b)?.iid).toBe(itemId2);
    });

    it("PullItemsQuerySchema requires a limit and rejects oversize", () => {
        expect(PullItemsQuerySchema.safeParse({ since: "0" }).success).toBe(false);
        expect(PullItemsQuerySchema.safeParse({}).success).toBe(false);
        expect(PullItemsQuerySchema.safeParse({ since: "0", limit: "10" }).success).toBe(true);
        expect(
            PullItemsQuerySchema.safeParse({
                since: "0",
                limit: String(SYNC_LIMITS.PULL_PAGE_SIZE + 1),
            }).success,
        ).toBe(false);
        expect(PullItemsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    });
});
