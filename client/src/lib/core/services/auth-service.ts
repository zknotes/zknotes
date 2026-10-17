import {
    assertKdfParamsFloor,
    DEFAULT_KDF_PARAMS,
    decryptItemKey,
    deriveAuthKey,
    deriveEncryptionKey,
    deriveMasterKey,
    encryptItemKey,
    type KdfParams,
    normalizeEmail,
    zeroize,
} from "@zknotes/shared";
import * as api from "$lib/core/api";
import { storeVaultKey } from "$lib/core/crypto/session-key";
import { authStore } from "$lib/core/stores/auth-store.svelte";
import { getUnsyncedWork, isVaultClean } from "$lib/core/sync/unsynced-work";
import { fromBase64, toBase64 } from "$lib/core/utils/base64";
import {
    loadPersisted,
    rawStringSerde,
    STORAGE_KEYS,
    savePersisted,
} from "$lib/core/utils/persisted";
import { logoutWorker, unlockWorker } from "$lib/core/workers/crypto-rpc";

export type PerformLoginResult =
    | { status: "ok" }
    | {
          status: "pending_unsynced";
          dirtyCount: number;
          uploadsActive: number;
          canDrain: boolean;
      };

/**
 * Where a sign-in is, for the UI. `contacting` and `signing-in` wait on the server; `deriving`
 * (Argon2id) and `unlocking` run on the device. The split lets the screen tell a slow server
 * apart from a slow device instead of calling all of it "Decrypting vault".
 */
export type LoginStage = "contacting" | "deriving" | "signing-in" | "unlocking";

export type PerformLoginOptions = {
    /** The user explicitly confirmed discarding the unsynchronised work. */
    discardUnsynced?: boolean;
    /** Called as the sign-in enters each stage. */
    onStage?: (stage: LoginStage) => void;
};

function canDrainLogin(): boolean {
    return authStore.isAuthenticated && authStore.isVaultUnlocked;
}

/**
 * The login gate: gate only when there is something to lose (the vault is not clean) and the
 * identity is not provably the same; a missing email → gate. A clean vault does not gate even a
 * different account.
 */
function shouldShowLoginGate(typedEmail: string, vaultClean: boolean): boolean {
    if (vaultClean) return false;
    const stored = loadPersisted(STORAGE_KEYS.storedEmail, "", rawStringSerde);
    if (!stored) return true;
    return normalizeEmail(stored) !== normalizeEmail(typedEmail);
}

/**
 * Clears the local IndexedDB cache when the user changed.
 * It prevents old, cryptographically incompatible data being visible to the new user.
 * Returns whether the user changed — the login uses the same predicate to decide whether
 * to rotate the session generation for the other open tabs; one place of truth for both effects.
 */
async function maybeClearLocalDataForUser(newUserId: string): Promise<boolean> {
    // "" when the key is absent — the comparison with newUserId then fails, exactly as it did with the former null
    const storedUserId = loadPersisted(STORAGE_KEYS.storedUserId, "", rawStringSerde);
    const userChanged = storedUserId !== newUserId;
    if (userChanged) {
        // Keep the old database so an offline re-login works; do not delete it at once.
        // The sync engine performs the real deletion AFTER the first successful pull from the server.
        savePersisted(STORAGE_KEYS.pendingClearForUser, "true", rawStringSerde);
    }
    savePersisted(STORAGE_KEYS.storedUserId, newUserId, rawStringSerde);
    return userChanged;
}

/** Login: fetch the KDF params → derive → /auth/login → decrypt the VK → unlockWorker → the session-key store. */
export async function performLogin(
    email: string,
    password: string,
    opts?: PerformLoginOptions,
): Promise<PerformLoginResult> {
    if (!opts?.discardUnsynced) {
        const work = await getUnsyncedWork();
        if (shouldShowLoginGate(email, isVaultClean(work))) {
            return {
                status: "pending_unsynced",
                dirtyCount: work.dirtyCount,
                uploadsActive: work.uploadsActive,
                canDrain: canDrainLogin(),
            };
        }
    }

    // The API stores and looks a vault up under the normalised address, so the two calls below have
    // to send that form — not whatever capitalisation the keyboard produced. Sending the raw string
    // used to miss the user's own row: getKdfParams answered with the anti-enumeration fake salt and
    // login then rejected a correct password, with no way to recover the vault.
    const normalizedEmail = normalizeEmail(email);

    opts?.onStage?.("contacting");
    const { kdf_salt, kdf_params } = await api.getKdfParams(normalizedEmail);
    assertKdfParamsFloor(kdf_params);

    let mk: Uint8Array | null = null;
    let encKey: Uint8Array | null = null;
    let vk: Uint8Array | null = null;
    try {
        const saltBytes = fromBase64(kdf_salt);
        opts?.onStage?.("deriving");
        mk = await deriveMasterKey(password, saltBytes, kdf_params);
        encKey = deriveEncryptionKey(mk);
        const authKey = deriveAuthKey(mk);

        opts?.onStage?.("signing-in");
        const loginData = await api.login(normalizedEmail, toBase64(authKey));
        zeroize(authKey);

        const userChanged = await maybeClearLocalDataForUser(loginData.user_id);
        savePersisted(STORAGE_KEYS.storedEmail, normalizedEmail, rawStringSerde);
        // Rotate the session generation and tell the other tabs ONLY on a change of
        // user — a re-login by the same user (after a session expiry, say) shares the cookie and the VK
        // with the other tabs, so no kick is needed. It has to come before unlockWorker: the old tab
        // needs to find out before this one becomes the SharedWorker's owner.
        if (userChanged) {
            // A dynamic import (the same pattern as performDeleteAccount below): session-service.ts
            // eagerly instantiates UI stores (datetime-settings and friends) that touch localStorage
            // on import — a static import would pull that into a plain Node test environment with no DOM too.
            const { rotateSessionForUserChange, runSessionTeardownHooks } = await import(
                "$lib/core/services/session-service"
            );
            rotateSessionForUserChange();
            // This tab may still hold the previous user's decrypted query cache (a 401 or an
            // expired session skipped the SPA logout) — drop it before the new user's layout mounts.
            runSessionTeardownHooks();
        }

        // Decrypt the Vault Key with the Encryption Key
        opts?.onStage?.("unlocking");
        vk = decryptItemKey(
            fromBase64(loginData.encrypted_vault_key),
            fromBase64(loginData.vault_key_nonce),
            encKey,
        );

        // Before a new unlock, wipe the previous itemKeys, search and share keys in the
        // SharedWorker (INIT now wipes as well, but an explicit LOGOUT is a clear handoff and works
        // on older workers too).
        await logoutWorker().catch(() => {});
        await unlockWorker(vk);
        storeVaultKey(toBase64(vk));
        return { status: "ok" };
    } finally {
        if (mk) zeroize(mk);
        if (encKey) zeroize(encKey);
        if (vk) zeroize(vk);
    }
}

/**
 * Creating the vault. The same derivation as a registration — the password derives the Master Key
 * **on the device**, then the Auth Key and the Encryption Key from it, while the Vault Key is
 * generated at random and wrapped. The server receives only the Auth Key's hash and the wrapped Vault
 * Key; the password never leaves the browser.
 *
 * The difference from the old registration: there is **no acceptance of Terms** (those live on
 * another origin), and it carries an optional one-time pass from an extended deployment. With no
 * pass this is a self-host's first registration.
 *
 * Every derived key is zeroized in `finally`, including when the call fails.
 */
export async function performCreateVault(
    email: string,
    password: string,
    token?: string,
): Promise<void> {
    const newSalt = new Uint8Array(16);
    crypto.getRandomValues(newSalt);

    let mk: Uint8Array | null = null;
    let authKey: Uint8Array | null = null;
    let encKey: Uint8Array | null = null;
    let vaultKey: Uint8Array | null = null;
    try {
        mk = await deriveMasterKey(password, newSalt, DEFAULT_KDF_PARAMS);
        encKey = deriveEncryptionKey(mk);
        authKey = deriveAuthKey(mk);

        const vkBuf = new ArrayBuffer(32);
        crypto.getRandomValues(new Uint8Array(vkBuf));
        vaultKey = new Uint8Array(vkBuf);
        const { ciphertext: encVK, nonce: vkNonce } = encryptItemKey(vaultKey, encKey);

        await api.createVault({
            // The same canonical form the API stores, so a later sign-in with any capitalisation
            // finds this row.
            email: normalizeEmail(email),
            auth_key: toBase64(authKey),
            kdf_salt: toBase64(newSalt),
            kdf_params: DEFAULT_KDF_PARAMS,
            encrypted_vault_key: toBase64(encVK),
            vault_key_nonce: toBase64(vkNonce),
            ...(token ? { token } : {}),
        });
    } finally {
        if (encKey) zeroize(encKey);
        if (authKey) zeroize(authKey);
        if (mk) zeroize(mk);
        if (vaultKey) zeroize(vaultKey);
    }
}

/**
 * A password change: it checks the old password by decrypting the VK → re-encrypts the same VK under
 * the new EK → one atomic API call. The Item Keys are untouched.
 */
export async function performChangePassword(params: {
    currentPassword: string;
    newPassword: string;
    onProgress: (msg: string) => void;
}): Promise<void> {
    const { currentPassword, newPassword, onProgress } = params;

    let oldMk: Uint8Array | undefined;
    let oldAuthKey: Uint8Array | undefined;
    let oldEncKey: Uint8Array | undefined;
    let oldVK: Uint8Array | undefined;
    let newMk: Uint8Array | undefined;
    let newAuthKey: Uint8Array | undefined;
    let newEncKey: Uint8Array | undefined;

    try {
        onProgress("Fetching your current parameters…");
        const meData = await api.getMe();
        assertKdfParamsFloor(meData.kdf_params);

        const oldSalt = fromBase64(meData.kdf_salt);

        onProgress("Checking your current password (this can take a moment)…");
        await new Promise((r) => setTimeout(r, 50));

        oldMk = await deriveMasterKey(currentPassword, oldSalt, meData.kdf_params);
        oldAuthKey = deriveAuthKey(oldMk);
        oldEncKey = deriveEncryptionKey(oldMk);

        // Decrypting the VK is the password check itself — a wrong EK → a Poly1305 tag failure → it throws
        try {
            oldVK = decryptItemKey(
                fromBase64(meData.encrypted_vault_key),
                fromBase64(meData.vault_key_nonce),
                oldEncKey,
            );
        } catch {
            throw new Error("That is not your current password.");
        }

        onProgress("Generating new keys…");
        await new Promise((r) => setTimeout(r, 50));

        const newSalt = new Uint8Array(16);
        crypto.getRandomValues(newSalt);
        newMk = await deriveMasterKey(newPassword, newSalt, DEFAULT_KDF_PARAMS);
        newAuthKey = deriveAuthKey(newMk);
        newEncKey = deriveEncryptionKey(newMk);

        // We re-encrypt the same VK with the new EK — the Item Keys stay unchanged
        const { ciphertext: newEncVK, nonce: newVKNonce } = encryptItemKey(oldVK, newEncKey);

        onProgress("Saving to the server…");
        await api.changePassword({
            current_auth_key: toBase64(oldAuthKey),
            new_auth_key: toBase64(newAuthKey),
            new_kdf_salt: toBase64(newSalt),
            new_kdf_params: DEFAULT_KDF_PARAMS,
            new_encrypted_vault_key: toBase64(newEncVK),
            new_vault_key_nonce: toBase64(newVKNonce),
        });

        // The worker still holds the same VK — the password changed, but the VK did not.
        // There is no need to re-unlock; storeVaultKey is unchanged, because the VK did not rotate.
    } finally {
        for (const k of [oldMk, newMk, oldAuthKey, newAuthKey, oldEncKey, newEncKey, oldVK]) {
            if (k) zeroize(k);
        }
    }
}

/** Account delete: derive the auth key → DELETE /auth/account → cleanup. */
export async function performDeleteAccount(password: string): Promise<void> {
    const meData = await api.getMe();
    assertKdfParamsFloor(meData.kdf_params);
    const saltBytes = fromBase64(meData.kdf_salt);

    let mk: Uint8Array | undefined;
    let ak: Uint8Array | undefined;
    try {
        mk = await deriveMasterKey(password, saltBytes, meData.kdf_params);
        ak = deriveAuthKey(mk);

        await api.deleteAccount(toBase64(ak));
    } finally {
        if (mk) zeroize(mk);
        if (ak) zeroize(ak);
    }

    // The shared teardown sequence (the same as logout) — core/services/session-service.ts
    const { teardownSession } = await import("$lib/core/services/session-service");
    await teardownSession();
}

/** Fetches the KDF parameters for display in the UI. */
export async function fetchKdfParams(): Promise<KdfParams | null> {
    try {
        const d = await api.getMe();
        return d.kdf_params ?? null;
    } catch {
        return null;
    }
}
