// The domain client for the /auth/* endpoints — the only place that knows the URLs and the
// request/response shapes. The crypto logic (the derivation, the zeroize) stays in services/auth.ts;
// these are thin HTTP calls alone.
import { PROBE_TIMEOUT_MS } from "$lib/core/constants/reachability";
import type { ChangePasswordRequest, KdfParams, VaultCreateInput } from "@zknotes/shared";
import { apiFetch } from "./client";

/** The KDF metadata from the server — both /auth/kdf-params and /auth/me return it. */
export interface KdfMetadata {
    kdf_salt: string;
    kdf_params: KdfParams;
}

/** The extended /auth/me and /auth/login response, which carries the Vault Key fields too. */
export interface KdfMetadataWithVaultKey extends KdfMetadata {
    /** The signed-in vault's address — shown wherever the user must know *which* vault they act on. */
    email?: string;
    encrypted_vault_key: string;
    vault_key_nonce: string;
}

// The first request of a sign-in, and a lookup the server answers in milliseconds (the hashing
// happens later, on the device). A stalled server — paused, or wedged on its database — accepts
// the connection and never replies; the general 30 s timeout left "Unlock vault" spinning that long
// before saying anything.
const KDF_PARAMS_TIMEOUT_MS = PROBE_TIMEOUT_MS;

/** POST /auth/kdf-params — the salt+params for the login derivation (fake ones for unknown emails). */
export async function getKdfParams(email: string): Promise<KdfMetadata> {
    return apiFetch("/auth/kdf-params", {
        method: "POST",
        body: JSON.stringify({ email }),
        timeoutMs: KDF_PARAMS_TIMEOUT_MS,
    });
}

/** POST /auth/login — it sets the session cookie and returns the user id and the VK fields. */
export async function login(
    email: string,
    authKey: string,
): Promise<{ user_id: string; encrypted_vault_key: string; vault_key_nonce: string }> {
    return apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, auth_key: authKey }),
    });
}

/**
 * POST /vault — creating the vault.
 *
 * The replacement for `/auth/register`: the account and the Terms live on another origin, and
 * what arrives here is **key material only**, derived by the client from the vault password.
 * `token` is a one-time pass from an extended deployment; a self-host has none.
 */
export async function createVault(body: VaultCreateInput): Promise<{ created: boolean }> {
    return apiFetch("/vault", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Public registration status. The core returns **only** `open` (self-host: is a vault already
 * open?); the rest comes from an extension once it takes the route over, so it is optional.
 */
export interface RegistrationStatus {
    /** Can a new vault be opened on **this** instance right now. */
    open: boolean;
    /** A beta-phase flag, sent only by an extended deployment. */
    beta?: boolean;
    count?: number;
    /** `0` = no limit. */
    cap?: number;
}

/** GET /auth/registration-status — whether one may register, plus beta/cap where they exist. */
export async function getRegistrationStatus(): Promise<RegistrationStatus> {
    return apiFetch("/auth/registration-status");
}

/** GET /auth/me — the current user's KDF metadata + VK fields. */
export async function getMe(): Promise<KdfMetadataWithVaultKey> {
    return apiFetch("/auth/me");
}

/** POST /auth/change-password — atomic: a new auth key + every item key re-wrapped. */
export async function changePassword(body: ChangePasswordRequest): Promise<void> {
    await apiFetch("/auth/change-password", { method: "POST", body: JSON.stringify(body) });
}

/** DELETE /auth/account — deletes the account and all of its data (the auth key is required as confirmation). */
export async function deleteAccount(authKey: string): Promise<void> {
    await apiFetch("/auth/account", {
        method: "DELETE",
        body: JSON.stringify({ auth_key: authKey }),
    });
}

/** POST /auth/logout — the server-side session invalidation. */
export async function logout(): Promise<void> {
    await apiFetch("/auth/logout", { method: "POST" });
}

export interface SessionInfo {
    id: string;
    expires_at: number;
    created_at: number;
    last_used_at: number;
    user_agent: string | null;
    ip_address: string | null;
    is_current: boolean;
}

/** GET /auth/sessions — list of active sessions for the user */
export async function getSessions(): Promise<{ sessions: SessionInfo[] }> {
    return apiFetch("/auth/sessions");
}

/** DELETE /auth/sessions/:id — revoke a specific session */
export async function deleteSession(id: string): Promise<void> {
    await apiFetch(`/auth/sessions/${id}`, { method: "DELETE" });
}
