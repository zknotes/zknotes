import { describe, expect, it, vi } from "vitest";
import * as api from "$lib/core/api";
import { performLogin, performChangePassword, performDeleteAccount } from "./auth-service";

vi.mock("$lib/core/api", () => ({
    getKdfParams: vi.fn(),
    login: vi.fn(),
    getMe: vi.fn(),
    changePassword: vi.fn(),
    deleteAccount: vi.fn(),
}));

vi.mock("@zknotes/shared", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@zknotes/shared")>();
    return {
        ...actual,
        assertKdfParamsFloor: vi.fn((params) => {
            if (params.m < 65536) {
                throw new Error(
                    "The server returned unsafe security parameters — the sign-in was stopped",
                );
            }
        }),
    };
});

vi.mock("$lib/core/workers/crypto-rpc", () => ({
    logoutWorker: vi.fn().mockResolvedValue(undefined),
    unlockWorker: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/core/crypto/session-key", () => ({
    storeVaultKey: vi.fn(),
}));

vi.mock("$lib/core/sync/unsynced-work", () => ({
    getUnsyncedWork: vi.fn().mockResolvedValue({ dirtyCount: 0, uploadsActive: 0 }),
    isVaultClean: () => true,
}));

vi.mock("$lib/core/stores/auth-store.svelte", () => ({
    authStore: { isAuthenticated: false, isVaultUnlocked: false },
}));

describe("auth-service KDF floor enforcement", () => {
    it("performLogin refuses weak kdf_params from the server", async () => {
        vi.mocked(api.getKdfParams).mockResolvedValueOnce({
            kdf_salt: "c2FsdHNhbHRzYWx0c2FsdA==", // 16B base64
            kdf_params: { m: 1024, t: 1, p: 1 },
        });

        await expect(performLogin("test@example.com", "password123")).rejects.toThrow(
            "The server returned unsafe security parameters",
        );

        // api.login must not be called when the KDF floor fails
        expect(api.login).not.toHaveBeenCalled();
    });

    it("performChangePassword refuses weak kdf_params from getMe", async () => {
        vi.mocked(api.getMe).mockResolvedValueOnce({
            id: "user-1",
            email: "test@example.com",
            kdf_salt: "c2FsdHNhbHRzYWx0c2FsdA==",
            kdf_params: { m: 1024, t: 1, p: 1 },
            encrypted_vault_key: "dmF1bHRrZXk=",
            vault_key_nonce: "bm9uY2Vub25jZQ==",
            storage_used_bytes: 0,
        } as any);

        await expect(
            performChangePassword({
                currentPassword: "oldPassword",
                newPassword: "newPassword123!",
                onProgress: () => {},
            }),
        ).rejects.toThrow("The server returned unsafe security parameters");

        expect(api.changePassword).not.toHaveBeenCalled();
    });

    it("performDeleteAccount refuses weak kdf_params from getMe", async () => {
        vi.mocked(api.getMe).mockResolvedValueOnce({
            id: "user-1",
            email: "test@example.com",
            kdf_salt: "c2FsdHNhbHRzYWx0c2FsdA==",
            kdf_params: { m: 1024, t: 1, p: 1 },
            encrypted_vault_key: "dmF1bHRrZXk=",
            vault_key_nonce: "bm9uY2Vub25jZQ==",
            storage_used_bytes: 0,
        } as any);

        await expect(performDeleteAccount("password123")).rejects.toThrow(
            "The server returned unsafe security parameters",
        );

        expect(api.deleteAccount).not.toHaveBeenCalled();
    });
});
