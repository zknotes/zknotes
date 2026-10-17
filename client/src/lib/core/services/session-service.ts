/**
 * Session lifecycle — restoring the vault key after a tab reload, and the teardown sequence
 * which used to be duplicated between the layout's handleLogout and performDeleteAccount.
 *
 * Cross-tab logout: BroadcastChannel("vault-session") + a session generation in
 * localStorage (session-key.ts) — other tabs must not keep vault access, nor "resurrect" the key
 * from sessionStorage after a reload.
 */
import { zeroize } from "@zknotes/shared";
import { logout } from "$lib/core/api";
import {
    bindSessionGeneration,
    clearVaultKey,
    getStoredVaultKey,
    invalidateSessionGeneration,
    isVaultSessionCurrent,
} from "$lib/core/crypto/session-key";
import { resetItemMetaCache } from "$lib/core/data/items";
import { clearAllLocalChunks } from "$lib/core/db/file-chunks";
import { fileBridge } from "$lib/core/events/file-bridge";
import { resetChunkCacheCounters } from "$lib/core/files/chunk-loader";
import { evictChunkHttpCache } from "$lib/core/files/evict-chunk-cache";
import { cancelPendingPersist, flushIndex } from "$lib/core/search";
import { authStore } from "$lib/core/stores/auth-store.svelte";
import { conflictStore } from "$lib/core/stores/conflict-store.svelte";
import { dateTimeSettings } from "$lib/core/stores/datetime-settings.svelte";
import { outlineStore } from "$lib/core/stores/outline.svelte";
import { searchIndexStore } from "$lib/core/stores/search-index.svelte";
import { fromBase64 } from "$lib/core/utils/base64";
import {
    logoutWorker,
    PING_RETRY_TIMEOUT_MS,
    pingWorkerStatus,
    unlockWorker,
    type WorkerPingStatus,
} from "$lib/core/workers/crypto-rpc";

const VAULT_SESSION_CHANNEL = "vault-session";
const TAB_ID =
    typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `tab-${Math.random().toString(36).slice(2)}`;

/**
 * "logout" — the sender left the session (a server logout, a 401, a delete account); the receiver
 * does a full teardown (the worker lock, deleting vault_key, a RAM cleanup) and redirects.
 * "user-changed" — the sender (the signing-in tab) has just signed in a DIFFERENT user; the
 * receiver performs a NARROWED teardown (a RAM cleanup plus clearVaultKey, without logoutWorker or
 * a second invalidate), because the signing-in tab owns the SharedWorker and has to stay alive. The
 * two must not be mixed: reusing "logout" on a login would zeroize the login tab's VK.
 */
type VaultSessionMessage =
    | { type: "logout"; originTabId: string }
    | { type: "user-changed"; originTabId: string };

let sessionChannel: BroadcastChannel | undefined;
let remoteLogoutInFlight = false;
let remoteUserChangeInFlight = false;

// ── Teardown hooks ──────────────────────────────────────────────────────────
// Plaintext the UI layer keeps in memory that core cannot reach from here — the TanStack Query
// cache above all (decrypted note HTML under QUERY_KEYS.note, decrypted titles under treeItems).
// It survived logout: with the default gcTime that plaintext stayed in the heap for minutes, and a
// different user signing in in the same tab was served the previous user's decrypted tree from the
// cache while getTreeItems() refetched. The root layout registers `() => queryClient.clear()`; every
// session-ending path (logout, 401, user-changed, a different user's login) runs the hooks.

type SessionTeardownHook = () => void;
const teardownHooks = new Set<SessionTeardownHook>();

/** Registers a hook run on every session teardown. Returns the unregister function. */
export function registerSessionTeardownHook(fn: SessionTeardownHook): () => void {
    teardownHooks.add(fn);
    return () => {
        teardownHooks.delete(fn);
    };
}

/** Runs every registered teardown hook. Best-effort: one failing hook must not stop the others. */
export function runSessionTeardownHooks(): void {
    for (const fn of teardownHooks) {
        try {
            fn();
        } catch (e) {
            console.error("session teardown hook failed", e);
        }
    }
}

function redirectToLogin(): void {
    // Do not import $app/navigation here — session-service is also loaded in the Vitest unit
    // environment, which has no SvelteKit aliases. A soft redirect through location instead.
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.assign("/login");
    }
}

function handleRemoteLogout(): void {
    if (remoteLogoutInFlight || !authStore.isVaultUnlocked) {
        // Even if the UI believes it is locked, clear any stale vault_key.
        if (!isVaultSessionCurrent()) clearVaultKey();
        return;
    }
    remoteLogoutInFlight = true;
    void teardownSession({ broadcast: false })
        .then(redirectToLogin)
        .finally(() => {
            remoteLogoutInFlight = false;
        });
}

/**
 * The receiver of "user-changed": a different user signed in in another tab. A narrowed teardown —
 * a RAM/local cleanup + clearVaultKey + authStore.logout() + a redirect. It does NOT call
 * invalidateSessionGeneration() (the sender already rotated before broadcasting) nor logoutWorker()
 * (the SharedWorker is origin-scoped; the sender has just re-inited it for the new user —
 * a LOGOUT from this tab would zeroize that freshly set VK).
 */
function handleRemoteUserChange(): void {
    if (remoteUserChangeInFlight || !authStore.isVaultUnlocked) {
        if (!isVaultSessionCurrent()) clearVaultKey();
        return;
    }
    remoteUserChangeInFlight = true;
    void clearLocalSessionState()
        .then(() => {
            clearVaultKey();
            authStore.logout();
            redirectToLogin();
        })
        .finally(() => {
            remoteUserChangeInFlight = false;
        });
}

/**
 * Registers the cross-tab session listener (logout + user-changed). Idempotent — call it from the
 * root layout.
 */
export function attachVaultSessionChannel(): void {
    if (typeof BroadcastChannel === "undefined" || sessionChannel) return;
    sessionChannel = new BroadcastChannel(VAULT_SESSION_CHANNEL);
    sessionChannel.onmessage = (event: MessageEvent<VaultSessionMessage>) => {
        const data = event.data;
        if (!data || data.originTabId === TAB_ID) return;
        if (data.type === "logout") {
            handleRemoteLogout();
        } else if (data.type === "user-changed") {
            handleRemoteUserChange();
        }
    };
}

function broadcastVaultSessionChange(type: "logout" | "user-changed"): void {
    if (typeof BroadcastChannel === "undefined") return;
    attachVaultSessionChannel();
    sessionChannel?.postMessage({ type, originTabId: TAB_ID } satisfies VaultSessionMessage);
}

/**
 * Rotates the session generation and tells the other tabs that this browser has signed in
 * a different user. It is called from `performLogin`, after `api.login` and before
 * `unlockWorker`, and ONLY when `loginData.user_id !== storedUserId` — a re-login by the same
 * user does not rotate (the same VK, a shared cookie, and that user's other tabs need no kicking).
 * Unlike `teardownSession` it touches neither the crypto worker nor the local cache — the login tab
 * (the sender) stays alive and continues with its own `logoutWorker`, `unlockWorker` and `storeVaultKey`.
 */
export function rotateSessionForUserChange(): void {
    invalidateSessionGeneration();
    broadcastVaultSessionChange("user-changed");
}

/**
 * Whether the worker holds the Vault Key, waiting out a worker that is merely busy: a
 * SharedWorker building the search index answers no tab for seconds, and a timeout is not "locked".
 * One that answers "locked" is taken at its word at once; one that does not answer the second, longer
 * ping either comes back as `"timeout"` — about 22 s in all.
 */
async function pingUntilAnswered(): Promise<WorkerPingStatus> {
    const first = await pingWorkerStatus();
    if (first !== "timeout") return first;
    return pingWorkerStatus(PING_RETRY_TIMEOUT_MS);
}

/**
 * Tries to unlock the crypto worker: a ping first (the SharedWorker may already hold the key
 * from another tab), then a session restore out of sessionStorage. It sets authStore
 * on success. Returns whether the vault is unlocked.
 *
 * A stale vault_key left after a logout in another tab (a session generation mismatch) is cleared and
 * must not re-unlock the worker — that is the "resurrection" bypass.
 */
export async function restoreSession(): Promise<boolean> {
    attachVaultSessionChannel();

    // A logout in another tab invalidates the generation — we must not resurrect vault_key.
    if (getStoredVaultKey() && !isVaultSessionCurrent()) {
        clearVaultKey();
    }

    const status = await pingUntilAnswered();
    let unlocked = status === true;

    // Only a worker that said "locked" gets this tab's key. One that never answered would queue the
    // INIT behind whatever holds it, and the tab would wait another 30 s.
    if (status === false) {
        const storedKey = getStoredVaultKey();
        if (storedKey && isVaultSessionCurrent()) {
            // unlockWorker transfers a COPY of the buffer — the original stays alive on the heap, so
            // we zeroize it by hand (the same pattern as auth-service).
            let vk: Uint8Array | null = null;
            try {
                vk = fromBase64(storedKey);
                await unlockWorker(vk);
                unlocked = (await pingUntilAnswered()) === true;
            } catch (e) {
                console.error("Failed to restore session from storage", e);
            } finally {
                if (vk) zeroize(vk);
            }
        }
    }

    if (unlocked) {
        // The belt fix: this tab has just been confirmed as part of the CURRENT session,
        // either through a ping to the shared SharedWorker that another tab already unlocked, or
        // through its own sessionStorage key — so bind the tab generation to the current global one.
        // Without this, a tab that unlocked PURELY through the ping (another tab in the same
        // BrowserContext that never called storeVaultKey itself) would never have a
        // SESSION_GEN_TAB_KEY, so isVaultSessionCurrent() would always return false for it — a false
        // "the session is not valid" even for a perfectly legitimate tab.
        bindSessionGeneration();
        authStore.setUnlocked(true);
        authStore.setAuthenticated(true);
    }
    return unlocked;
}

export type TeardownSessionOptions = {
    /**
     * Send the BroadcastChannel logout to the other tabs (true by default).
     * false = we are receiving a remote logout (avoid the echo loop).
     */
    broadcast?: boolean;
};

/**
 * The local RAM and cache cleanup shared by the full logout teardown and the narrowed user-changed
 * teardown: flushing and resetting the search index, revoking the blob URLs, clearing the
 * ciphertext chunk cache (IDB plus a best-effort HTTP cache) and resetting the per-browser UI
 * defaults (the outline). It touches neither the session generation, nor vault_key, nor the crypto
 * worker — the caller (teardownSession vs handleRemoteUserChange) decides those, because they
 * differ. Best-effort: a failure of ANY step here is only logged — the caller has to continue to
 * clearVaultKey and authStore.logout even if this throws.
 */
async function clearLocalSessionState(): Promise<void> {
    // First, before any await: the UI-layer plaintext (the query cache) must not outlive this call
    // even if a later best-effort step throws.
    runSessionTeardownHooks();
    try {
        const { abortAllInFlightUploads, clearAllPendingUploadsOnLogout } = await import(
            "$lib/modules/files/upload-manager"
        );
        abortAllInFlightUploads();
        await clearAllPendingUploadsOnLogout().catch(() => {});
        await flushIndex();
        cancelPendingPersist();
        searchIndexStore.reset();
        // Before the blob cache: cancel the scheduled pending-trash timers so they do not fire after sign-out.
        fileBridge.cancelPendingTrash();
        fileBridge.clearBlobCache();
        resetItemMetaCache();
        await clearAllLocalChunks();
        resetChunkCacheCounters();
        await evictChunkHttpCache();
        conflictStore.clear();
        outlineStore.reset();
        dateTimeSettings.reset();
    } catch (err) {
        console.error("clearLocalSessionState: best-effort cleanup step failed", err);
    }
}

/**
 * The full teardown when leaving a session (logout, delete account, a remote logout): it rotates
 * the generation and broadcasts, cleans the local RAM/caches, locks the crypto worker, deletes the
 * vault key from sessionStorage and resets the auth state.
 */
export async function teardownSession(opts: TeardownSessionOptions = {}): Promise<void> {
    const broadcast = opts.broadcast !== false;

    // Invalidate the generation and broadcast first — the other tabs then stop restoring at once.
    invalidateSessionGeneration();
    if (broadcast) broadcastVaultSessionChange("logout");

    await clearLocalSessionState();
    await logoutWorker().catch((err) => {
        console.error("teardownSession: logoutWorker failed", err);
    });
    clearVaultKey();
    authStore.logout();
}

/** Logout: the server-side session invalidation (best-effort) + the local teardown. */
export async function performLogout(): Promise<void> {
    try {
        await logout();
    } catch (e) {
        console.error("Failed to logout on server", e);
    }
    await teardownSession();
}

// ── A 401/403 on a protected route ──────────────────────────────────────────
// Before: only a goto /login → vault_key, the worker and isVaultUnlocked all survived (a revoke bypass).
// Now: a single-flight teardownSession, then a redirect (the same model as a cross-tab logout).

let unauthorizedTeardownInFlight = false;

/**
 * The global handler for an apiFetch 401/403 (on the non-/auth/ routes).
 * Single-flight: a burst of parallel 401s must not start N teardowns.
 * The redirect goes through location.assign (rather than $app/navigation) — that works under Vitest
 * and avoids a half-SPA state with the stores still unlocked.
 */
export function handleUnauthorizedSession(reason?: "expired" | "locked"): void {
    // Single-flight only for the 401s arriving concurrently during the teardown; it resets in the
    // finally (for the tests, and for a possible soft navigation with no unload).
    if (unauthorizedTeardownInFlight) return;
    unauthorizedTeardownInFlight = true;

    void teardownSession({ broadcast: true })
        .catch((e) => console.error("Unauthorized session teardown failed", e))
        .finally(() => {
            try {
                if (typeof window === "undefined") return;
                const searchParams = new URLSearchParams();
                // A code, never a sentence: the login page shows only the codes it knows, since anyone
                // can link to /login?error=….
                searchParams.set("error", reason === "locked" ? "account_locked" : "session_ended");
                const target = `/login?${searchParams.toString()}`;
                // A full navigation — it guarantees a clean root layout plus a fresh restoreSession attempt.
                window.location.assign(target);
            } finally {
                unauthorizedTeardownInFlight = false;
            }
        });
}
