// Tests the maybeClearLocalDataForUser logic (the user_id fix): a re-login by the SAME user must
// not delete IDB; a login by a DIFFERENT user has to.
// The environment: node + fake-indexeddb + a mocked `persisted` (node has no localStorage).
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A simulated "localStorage" for loadPersisted/savePersisted (the node env has none).
// The name has to start with "mock" for Vitest to allow a reference from a hoisted vi.mock block.
const mockLocalStorage: Record<string, string> = {};

const {
    loginMock,
    getKdfParamsMock,
    getMeMock,
    changePasswordMock,
    deleteAccountMock,
    teardownSessionMock,
    rotateSessionForUserChangeMock,
    runSessionTeardownHooksMock,
    decryptItemKeyMock,
    encryptItemKeyMock,
} = vi.hoisted(() => ({
    loginMock: vi.fn(),
    getKdfParamsMock: vi.fn().mockResolvedValue({
        kdf_salt: "AAAAAAAAAAAAAAAAAAAAAA==",
        kdf_params: { m: 1024, t: 1, p: 1 },
    }),
    getMeMock: vi.fn(),
    changePasswordMock: vi.fn().mockResolvedValue(undefined),
    deleteAccountMock: vi.fn().mockResolvedValue(undefined),
    teardownSessionMock: vi.fn().mockResolvedValue(undefined),
    rotateSessionForUserChangeMock: vi.fn(),
    runSessionTeardownHooksMock: vi.fn(),
    decryptItemKeyMock: vi.fn().mockReturnValue(new Uint8Array(32)),
    encryptItemKeyMock: vi.fn(),
}));

const mockAuthStore = vi.hoisted(() => ({
    isAuthenticated: false,
    isVaultUnlocked: false,
}));

vi.mock("$lib/core/utils/persisted", () => ({
    STORAGE_KEYS: {
        storedUserId: "zknotes_user_id",
        storedEmail: "zknotes_user_email",
        pendingClearForUser: "zknotes_pending_clear",
    },
    rawStringSerde: { serialize: (v: string) => v, deserialize: (v: string) => v },
    loadPersisted: vi.fn((key: string, fallback: string) => mockLocalStorage[key] ?? fallback),
    savePersisted: vi.fn((key: string, value: string) => {
        mockLocalStorage[key] = value as string;
    }),
}));

vi.mock("$lib/core/stores/auth-store.svelte", () => ({
    authStore: mockAuthStore,
}));

vi.mock("@zknotes/shared", () => ({
    DEFAULT_KDF_PARAMS: { m: 1024, t: 1, p: 1 },
    assertKdfParamsFloor: vi.fn(),
    deriveMasterKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
    deriveAuthKey: vi.fn().mockReturnValue(new Uint8Array(32)),
    deriveEncryptionKey: vi.fn().mockReturnValue(new Uint8Array(32)),
    decryptItemKey: decryptItemKeyMock,
    encryptItemKey: encryptItemKeyMock,
    // The real implementation, not a stub: the login gate compares the typed address against the
    // stored one through it (the rule is literally "the same email, case-insensitively"), and
    // performLogin sends its result to the API — a stub would make those assertions vacuous.
    normalizeEmail: (email: string) => email.trim().toLowerCase(),
    zeroize: vi.fn(),
}));

vi.mock("$lib/core/api", () => ({
    getKdfParams: getKdfParamsMock,
    login: loginMock,
    getMe: getMeMock,
    changePassword: changePasswordMock,
    deleteAccount: deleteAccountMock,
}));

vi.mock("$lib/core/workers/crypto-rpc", () => ({
    unlockWorker: vi.fn().mockResolvedValue(undefined),
    logoutWorker: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/core/crypto/session-key", () => ({
    storeVaultKey: vi.fn(),
}));

vi.mock("$lib/core/utils/base64", () => ({
    fromBase64: vi.fn().mockReturnValue(new Uint8Array(16)),
    toBase64: vi.fn().mockReturnValue("AAAA"),
}));

vi.mock("$lib/core/services/session-service", () => ({
    teardownSession: teardownSessionMock,
    rotateSessionForUserChange: rotateSessionForUserChangeMock,
    runSessionTeardownHooks: runSessionTeardownHooksMock,
}));

import { getDB, type LocalItem } from "$lib/core/db";
import { performChangePassword, performDeleteAccount, performLogin } from "./auth-service";

function vaultKeyResponse(userId: string) {
    return {
        user_id: userId,
        encrypted_vault_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        vault_key_nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    };
}

async function seedItem(id: string): Promise<void> {
    const db = await getDB();
    await db.put("items", {
        id,
        type: "note",
        parent_id: null,
        encrypted_payload: "x",
        payload_nonce: "x",
        encrypted_item_key: "x",
        item_key_nonce: "x",
        sort_order: "m",
        version: 1,
        dirty: false,
        localRev: 0,
    } as LocalItem);
}

async function itemCount(): Promise<number> {
    return (await (await getDB()).getAll("items")).length;
}

const meFixture = {
    kdf_salt: "AAAAAAAAAAAAAAAAAAAAAA==",
    kdf_params: { m: 1024, t: 1, p: 1 },
    encrypted_vault_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    vault_key_nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
};

describe("maybeClearLocalDataForUser (the user_id fix)", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
        const db = await getDB();
        await db.clear("items");
    });

    it("re-signing in as the SAME user does not clear IDB", async () => {
        loginMock.mockResolvedValue(vaultKeyResponse("user-A"));

        await performLogin("a@test.com", "pw");
        await seedItem("note-1");
        expect(await itemCount()).toBe(1);

        await performLogin("a@test.com", "pw");
        expect(await itemCount()).toBe(1);
    });

    it("signing in as a DIFFERENT user sets the pendingClearForUser flag, without clearing IDB at once", async () => {
        loginMock.mockResolvedValue(vaultKeyResponse("user-A"));
        await performLogin("a@test.com", "pw");

        await seedItem("note-1");
        expect(await itemCount()).toBe(1);

        loginMock.mockResolvedValue(vaultKeyResponse("user-B"));
        await performLogin("b@test.com", "pw", { discardUnsynced: true });

        expect(mockLocalStorage["zknotes_pending_clear"]).toBe("true");
        expect(await itemCount()).toBe(1);
    });

    // Rotating the session generation is conditional on a change of user, the same predicate as the
    // pendingClearForUser flag above.
    // A first login in an empty browser (no storedUserId) COUNTS as a change — the same fallback as
    // maybeClearLocalDataForUser — so we isolate it with mockClear() before checking the re-login.
    it("a re-login by the SAME user does NOT rotate the session generation again", async () => {
        loginMock.mockResolvedValue(vaultKeyResponse("user-A"));

        await performLogin("a@test.com", "pw");
        expect(rotateSessionForUserChangeMock).toHaveBeenCalledOnce(); // the first login: no storedUserId → a "change"
        rotateSessionForUserChangeMock.mockClear();

        await performLogin("a@test.com", "pw");
        expect(rotateSessionForUserChangeMock).not.toHaveBeenCalled();
    });

    it("a login by a DIFFERENT user runs the session teardown hooks; the SAME user again does not", async () => {
        loginMock.mockResolvedValue(vaultKeyResponse("user-A"));
        await performLogin("a@test.com", "pw");
        runSessionTeardownHooksMock.mockClear();

        await performLogin("a@test.com", "pw");
        expect(runSessionTeardownHooksMock).not.toHaveBeenCalled();

        loginMock.mockResolvedValue(vaultKeyResponse("user-B"));
        await performLogin("b@test.com", "pw", { discardUnsynced: true });

        expect(runSessionTeardownHooksMock).toHaveBeenCalledOnce();
    });

    it("a login by a DIFFERENT user rotates the session generation before unlockWorker", async () => {
        loginMock.mockResolvedValue(vaultKeyResponse("user-A"));
        await performLogin("a@test.com", "pw");
        rotateSessionForUserChangeMock.mockClear();

        loginMock.mockResolvedValue(vaultKeyResponse("user-B"));
        await performLogin("b@test.com", "pw", { discardUnsynced: true });
        expect(rotateSessionForUserChangeMock).toHaveBeenCalledOnce();
    });
});

describe("performLogin gate", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
        mockAuthStore.isAuthenticated = false;
        mockAuthStore.isVaultUnlocked = false;
        const db = await getDB();
        await db.clear("items");
        await db.clear("mutation-queue");
        await db.clear("pending-uploads");
        loginMock.mockResolvedValue(vaultKeyResponse("user-A"));
    });

    it("a dirty row with a sync_error, with an empty queue, blocks api.login for a different account", async () => {
        mockLocalStorage.zknotes_user_email = "a@test.com";
        await seedItem("stuck");
        const db = await getDB();
        const row = await db.get("items", "stuck");
        if (!row) throw new Error("seed");
        row.dirty = true;
        row.sync_error = "hard_limit_exceeded";
        await db.put("items", row);

        const result = await performLogin("b@test.com", "pw");
        expect(result).toMatchObject({
            status: "pending_unsynced",
            dirtyCount: 1,
            uploadsActive: 0,
            canDrain: false,
        });
        expect(loginMock).not.toHaveBeenCalled();
        expect(getKdfParamsMock).not.toHaveBeenCalled();
    });

    it("storedEmail is missing + IDB is dirty → the gate (not a skip)", async () => {
        await seedItem("leftover");
        const db = await getDB();
        const row = await db.get("items", "leftover");
        if (!row) throw new Error("seed");
        row.dirty = true;
        await db.put("items", row);

        const result = await performLogin("b@test.com", "pw");
        expect(result.status).toBe("pending_unsynced");
        expect(loginMock).not.toHaveBeenCalled();
    });

    it("the same email (case-insensitively) + a dirty IDB → no gate", async () => {
        mockLocalStorage.zknotes_user_email = "a@test.com";
        await seedItem("own");
        const db = await getDB();
        const row = await db.get("items", "own");
        if (!row) throw new Error("seed");
        row.dirty = true;
        await db.put("items", row);

        const result = await performLogin("A@Test.com", "pw");
        expect(result).toEqual({ status: "ok" });
        expect(loginMock).toHaveBeenCalledOnce();
    });

    it("storedEmail is missing + IDB is empty → no gate (a first login)", async () => {
        const result = await performLogin("a@test.com", "pw");
        expect(result).toEqual({ status: "ok" });
        expect(loginMock).toHaveBeenCalledOnce();
        expect(mockLocalStorage.zknotes_user_email).toBe("a@test.com");
    });

    it("canDrain is true only while authenticated and unlocked", async () => {
        mockLocalStorage.zknotes_user_email = "a@test.com";
        await seedItem("x");
        const db = await getDB();
        const row = await db.get("items", "x");
        if (!row) throw new Error("seed");
        row.dirty = true;
        await db.put("items", row);

        mockAuthStore.isAuthenticated = true;
        mockAuthStore.isVaultUnlocked = false;
        let result = await performLogin("b@test.com", "pw");
        expect(result.status === "pending_unsynced" && result.canDrain).toBe(false);

        mockAuthStore.isVaultUnlocked = true;
        result = await performLogin("b@test.com", "pw");
        expect(result.status === "pending_unsynced" && result.canDrain).toBe(true);
    });

    it("discardUnsynced bypasses the gate and calls api.login", async () => {
        mockLocalStorage.zknotes_user_email = "a@test.com";
        await seedItem("x");
        const db = await getDB();
        const row = await db.get("items", "x");
        if (!row) throw new Error("seed");
        row.dirty = true;
        await db.put("items", row);

        const result = await performLogin("b@test.com", "pw", { discardUnsynced: true });
        expect(result).toEqual({ status: "ok" });
        expect(loginMock).toHaveBeenCalledOnce();
    });

    // The gate protects only work that would be lost. A different account with a clean vault has
    // nothing to lose — the gate used to rest on the email difference alone, so it asked for
    // confirmation with nothing to discard (and broke the second-user test in
    // e2e/27-multi-tab.spec.ts).
    it("different email + clean IDB → no gate, api.login runs", async () => {
        mockLocalStorage.zknotes_user_email = "a@test.com";
        loginMock.mockResolvedValue(vaultKeyResponse("user-B"));

        const result = await performLogin("b@test.com", "pw");

        expect(result).toEqual({ status: "ok" });
        expect(loginMock).toHaveBeenCalledOnce();
    });

    // Regression: the API stores and looks a vault up under the normalised address, but performLogin
    // sent whatever the keyboard produced. Typing the very address you registered with — mobile
    // keyboards capitalise the first letter of an email field — missed your own row, so
    // /auth/kdf-params answered with the anti-enumeration fake salt, the derivation ran against it,
    // and login rejected a correct password. With no password recovery, the vault was gone.
    it("sends the normalised address to kdf-params and login, whatever was typed", async () => {
        loginMock.mockResolvedValue(vaultKeyResponse("user-A"));

        const result = await performLogin("  Alice@Example.COM  ", "pw");

        expect(result).toEqual({ status: "ok" });
        expect(getKdfParamsMock).toHaveBeenCalledWith("alice@example.com");
        expect(loginMock).toHaveBeenCalledWith("alice@example.com", expect.any(String));
        // ...and the address remembered for the next sign-in gate is the same canonical form.
        expect(mockLocalStorage.zknotes_user_email).toBe("alice@example.com");
    });

    // "Sync then continue" (login/+page.svelte) calls performLogin again after the drain,
    // without discardUnsynced. Once the drain has cleaned the vault, the sign-in has to proceed —
    // otherwise the gate for a different email returns forever and the only way out is "Continue
    // anyway".
    it("a drain that cleans the IDB lets a different account log in", async () => {
        mockLocalStorage.zknotes_user_email = "a@test.com";
        await seedItem("pending");
        const db = await getDB();
        const row = await db.get("items", "pending");
        if (!row) throw new Error("seed");
        row.dirty = true;
        await db.put("items", row);

        const gated = await performLogin("b@test.com", "pw");
        expect(gated.status).toBe("pending_unsynced");
        expect(loginMock).not.toHaveBeenCalled();

        // The drain sent the row to the server — the engine then marks it clean.
        row.dirty = false;
        await db.put("items", row);
        loginMock.mockResolvedValue(vaultKeyResponse("user-B"));

        const result = await performLogin("b@test.com", "pw");
        expect(result).toEqual({ status: "ok" });
        expect(loginMock).toHaveBeenCalledOnce();
    });
});

describe("performChangePassword", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getMeMock.mockResolvedValue(meFixture);
        decryptItemKeyMock.mockReturnValue(new Uint8Array(32));
        encryptItemKeyMock.mockReturnValue({
            ciphertext: new Uint8Array([9]),
            nonce: new Uint8Array([8]),
        });
    });

    it("re-encrypts vault key and calls changePassword atomically", async () => {
        const progress: string[] = [];
        await performChangePassword({
            currentPassword: "old",
            newPassword: "new",
            onProgress: (msg) => progress.push(msg),
        });

        expect(changePasswordMock).toHaveBeenCalledOnce();
        expect(changePasswordMock).toHaveBeenCalledWith(
            expect.objectContaining({
                new_encrypted_vault_key: "AAAA",
                new_vault_key_nonce: "AAAA",
            }),
        );
        expect(progress.length).toBeGreaterThan(0);
    });

    it("throws when current password cannot decrypt vault key", async () => {
        decryptItemKeyMock.mockImplementation(() => {
            throw new Error("bad tag");
        });

        await expect(
            performChangePassword({
                currentPassword: "wrong",
                newPassword: "new",
                onProgress: () => {},
            }),
        ).rejects.toThrow("That is not your current password.");
        expect(changePasswordMock).not.toHaveBeenCalled();
    });
});

describe("performDeleteAccount", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getMeMock.mockResolvedValue(meFixture);
        teardownSessionMock.mockResolvedValue(undefined);
    });

    it("sends delete request and runs teardownSession", async () => {
        await performDeleteAccount("password");

        expect(deleteAccountMock).toHaveBeenCalledOnce();
        expect(teardownSessionMock).toHaveBeenCalledOnce();
    });
});

describe("performLogin stages", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // An earlier test leaves decryptItemKey throwing; clearAllMocks keeps implementations.
        decryptItemKeyMock.mockReset().mockReturnValue(new Uint8Array(32));
        for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
        const db = await getDB();
        await db.clear("items");
        loginMock.mockResolvedValue(vaultKeyResponse("user-A"));
    });

    it("reports server waits and device work as separate stages, in order", async () => {
        // The screen tells a slow server from a slow device only if it knows which one it is waiting on.
        const stages: string[] = [];
        await performLogin("a@test.com", "pw", { onStage: (s) => stages.push(s) });
        expect(stages).toEqual(["contacting", "deriving", "signing-in", "unlocking"]);
    });

    it("stops at 'contacting' when the server cannot be reached", async () => {
        getKdfParamsMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        const stages: string[] = [];
        await expect(
            performLogin("a@test.com", "pw", { onStage: (s) => stages.push(s) }),
        ).rejects.toThrow("Failed to fetch");
        expect(stages).toEqual(["contacting"]);
    });
});
