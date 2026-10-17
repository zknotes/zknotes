/**
 * ⚠ A SECURITY BOUNDARY — the only place in the application allowed to touch
 * sessionStorage["vault_key"].
 *
 * The Vault Key otherwise lives solely inside the crypto SharedWorker. Persisting it in
 * sessionStorage is a deliberate trade-off for restoring the session after a tab reload
 * (sessionStorage is per-tab and not shared with other origins; browsers may still write it to the
 * profile for session restore — see "Where keys live" in SECURITY.md).
 * `./check.sh` step 1 fails on the `vault_key` storage key anywhere else in `client/src` and
 * `shared/src`, on any line of this file that names VAULT_KEY without sessionStorage, and on any
 * other storage API here or in `lib/core/workers/`.
 *
 * Cross-tab logout: the localStorage `zknotes_session_gen` is rotated on logout. A tab holding
 * vault_key must have the same generation in its sessionStorage; otherwise restoreSession refuses to
 * "resurrect" the key after a logout in another tab.
 */

const VAULT_KEY = "vault_key";
/** Shared across tabs — rotated on logout. */
const SESSION_GEN_KEY = "zknotes_session_gen";
/** The per-tab copy of the generation as of storeVaultKey or sign-in. */
const SESSION_GEN_TAB_KEY = "zknotes_session_gen_tab";

/** The base64 Vault Key from session storage, or null (SSR / not unlocked). */
export function getStoredVaultKey(): string | null {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(VAULT_KEY);
}

export function storeVaultKey(base64Key: string): void {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(VAULT_KEY, base64Key);
    bindSessionGeneration();
}

export function clearVaultKey(): void {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(VAULT_KEY);
    sessionStorage.removeItem(SESSION_GEN_TAB_KEY);
}

export function hasVaultKey(): boolean {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(VAULT_KEY) !== null;
}

/**
 * Binds this tab to the current (or a new) session generation.
 * Called alongside storeVaultKey after a sign-in or an unlock.
 */
export function bindSessionGeneration(): void {
    if (typeof localStorage === "undefined" || typeof sessionStorage === "undefined") return;
    let gen = localStorage.getItem(SESSION_GEN_KEY);
    if (!gen) {
        gen = crypto.randomUUID();
        localStorage.setItem(SESSION_GEN_KEY, gen);
    }
    sessionStorage.setItem(SESSION_GEN_TAB_KEY, gen);
}

/**
 * Invalidates every existing tab-session binding (logout).
 * Tabs holding an old generation may no longer restore vault_key.
 */
export function invalidateSessionGeneration(): void {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SESSION_GEN_KEY, crypto.randomUUID());
}

/**
 * Is the per-tab vault_key still valid against the global logout generation?
 * false → clearVaultKey, and do not restore.
 */
export function isVaultSessionCurrent(): boolean {
    if (typeof localStorage === "undefined" || typeof sessionStorage === "undefined") return false;
    const globalGen = localStorage.getItem(SESSION_GEN_KEY);
    const tabGen = sessionStorage.getItem(SESSION_GEN_TAB_KEY);
    if (!tabGen || !globalGen) return false;
    return tabGen === globalGen;
}
