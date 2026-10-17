// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    logoutApi,
    flushIndex,
    logoutWorker,
    unlockWorker,
    pingWorkerStatus,
    abortUploadMock,
    deleteStagingMock,
} = vi.hoisted(() => ({
    logoutApi: vi.fn().mockResolvedValue(undefined),
    flushIndex: vi.fn().mockResolvedValue(undefined),
    logoutWorker: vi.fn().mockResolvedValue(undefined),
    unlockWorker: vi.fn().mockResolvedValue(undefined),
    pingWorkerStatus: vi.fn(),
    abortUploadMock: vi.fn().mockResolvedValue(undefined),
    deleteStagingMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/modules/files/opfs-staging", () => ({
    deleteStaging: deleteStagingMock,
}));

vi.mock("$lib/modules/files/upload-chunk-store", () => ({
    deleteAllUploadChunks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("$lib/core/api", () => ({
    logout: logoutApi,
}));

vi.mock("$lib/core/api/files", () => ({
    abortUpload: abortUploadMock,
}));

vi.mock("$lib/core/search", () => ({
    flushIndex,
    cancelPendingPersist: vi.fn(),
}));

vi.mock("$lib/core/workers/crypto-rpc", () => ({
    logoutWorker,
    unlockWorker,
    pingWorkerStatus,
    PING_RETRY_TIMEOUT_MS: 20_000,
}));

vi.mock("$lib/core/events/file-bridge", () => ({
    fileBridge: { clearBlobCache: vi.fn(), cancelPendingTrash: vi.fn() },
}));

vi.mock("$lib/core/stores/search-index.svelte", () => ({
    searchIndexStore: { reset: vi.fn() },
}));

vi.mock("$lib/core/stores/conflict-store.svelte", () => ({
    conflictStore: { clear: vi.fn() },
}));

// outline.svelte.ts imports $app/environment, which does not exist in the vitest environment (there is no
// SvelteKit alias) — mocked the same way as the other stores above.
vi.mock("$lib/core/stores/outline.svelte", () => ({
    outlineStore: { reset: vi.fn() },
}));

vi.mock("$lib/core/stores/datetime-settings.svelte", () => ({
    dateTimeSettings: { reset: vi.fn() },
}));

import {
    clearVaultKey,
    getStoredVaultKey,
    isVaultSessionCurrent,
    storeVaultKey,
} from "$lib/core/crypto/session-key";
import { getDB } from "$lib/core/db";
import { chunkKey, putLocalChunk } from "$lib/core/db/file-chunks";
import { fileBridge } from "$lib/core/events/file-bridge";
import { authStore } from "$lib/core/stores/auth-store.svelte";
import {
    attachVaultSessionChannel,
    handleUnauthorizedSession,
    performLogout,
    registerSessionTeardownHook,
    restoreSession,
    rotateSessionForUserChange,
    runSessionTeardownHooks,
    teardownSession,
} from "./session-service";

describe("session-service", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // clearAllMocks keeps a mockResolvedValueOnce a test did not use up — it would answer the next test.
        pingWorkerStatus.mockReset();
        sessionStorage.clear();
        localStorage.clear();
        authStore.setAuthenticated(false);
        authStore.setUnlocked(false);
        const db = await getDB();
        await db.clear("items");
        await db.clear("file-chunks");
        await db.clear("pending-uploads");
    });

    it("teardownSession clears vault key and auth state", async () => {
        authStore.setAuthenticated(true);
        authStore.setUnlocked(true);
        storeVaultKey("dGVzdA==");
        await teardownSession();

        expect(getStoredVaultKey()).toBeNull();
        expect(authStore.isAuthenticated).toBe(false);
        expect(authStore.isVaultUnlocked).toBe(false);
        expect(flushIndex).toHaveBeenCalledOnce();
        expect(logoutWorker).toHaveBeenCalledOnce();
    });

    // A regression: teardownSession used to be a flat sequence of awaits with no try/finally. A
    // failure of ANY best-effort step (clearAllLocalChunks, say, or the dynamic import of the
    // upload manager on a slow or offline network) used to break the whole sequence BEFORE
    // logoutWorker, clearVaultKey and authStore.logout — so the vault key survived a "successful"
    // logout.
    it("teardownSession still clears the worker key and auth state when a cleanup step throws", async () => {
        authStore.setAuthenticated(true);
        authStore.setUnlocked(true);
        storeVaultKey("dGVzdA==");
        vi.mocked(fileBridge.clearBlobCache).mockImplementationOnce(() => {
            throw new Error("boom: cleanup step failed");
        });

        await teardownSession();

        expect(getStoredVaultKey()).toBeNull();
        expect(authStore.isAuthenticated).toBe(false);
        expect(authStore.isVaultUnlocked).toBe(false);
        expect(logoutWorker).toHaveBeenCalledOnce();
    });

    // Pending-trash timers used to survive a logout. `pendingTrashManager.schedule()` sets a
    // setTimeout that calls FileService.trash() when it expires — after a sign-out that fails against
    // a locked vault, or writes a mutation into someone else's session. The teardown has to cancel
    // them.
    it("teardownSession cancels pending trash timers (they must not outlive logout)", async () => {
        authStore.setAuthenticated(true);
        authStore.setUnlocked(true);
        storeVaultKey("dGVzdA==");

        await teardownSession();

        expect(fileBridge.cancelPendingTrash).toHaveBeenCalledOnce();
    });

    it("teardownSession aborts active upload sessions and clears OPFS staging", async () => {
        const db = await getDB();
        await db.put("pending-uploads", {
            local_id: "loc-logout",
            name: "f.png",
            mime: "image/png",
            note_id: null,
            parent_id: null,
            created_at: Date.now(),
            chunk_set_id: "cs-logout-upload",
            phase: "uploading",
        });
        await db.put("pending-uploads", {
            local_id: "loc-staged",
            name: "big.bin",
            mime: "application/octet-stream",
            note_id: null,
            parent_id: null,
            created_at: Date.now(),
            staging_id: "loc-staged",
            staging_bytes_written: 1024,
            plain_size: 1024,
            storage_mode: "opfs",
            phase: "staging_source",
        });

        await teardownSession();

        expect(abortUploadMock).toHaveBeenCalledWith("cs-logout-upload");
        expect(deleteStagingMock).toHaveBeenCalledWith("loc-staged");
        expect(await db.count("pending-uploads")).toBe(0);
    });

    it("teardownSession clears persisted ciphertext chunks (logout cache eviction)", async () => {
        const db = await getDB();
        await putLocalChunk({
            key: chunkKey("cs-logout", 0),
            chunkSetId: "cs-logout",
            index: 0,
            ciphertext: new Uint8Array(16).fill(1),
            nonce: new Uint8Array(24).fill(2),
            storedAt: Date.now(),
        });

        await teardownSession();

        expect(await db.count("file-chunks")).toBe(0);
    });

    // Regression: the TanStack Query cache (decrypted note HTML and titles) lives in the root layout
    // and survived logout — plaintext stayed in the heap for gcTime, and a different user signing in
    // in the same tab was served the previous user's decrypted tree from the cache. The root layout
    // registers `queryClient.clear()` as a teardown hook; every session-ending path has to run it.
    describe("session teardown hooks (the UI-layer plaintext cache)", () => {
        it("teardownSession runs the registered hooks, and one failing hook does not stop the rest", async () => {
            const failing = vi.fn(() => {
                throw new Error("hook boom");
            });
            const clearQueryCache = vi.fn();
            const unregisterFailing = registerSessionTeardownHook(failing);
            const unregisterClear = registerSessionTeardownHook(clearQueryCache);
            authStore.setAuthenticated(true);
            authStore.setUnlocked(true);
            storeVaultKey("dGVzdA==");

            await teardownSession();

            expect(failing).toHaveBeenCalledOnce();
            expect(clearQueryCache).toHaveBeenCalledOnce();
            expect(getStoredVaultKey()).toBeNull();
            expect(logoutWorker).toHaveBeenCalledOnce();
            unregisterFailing();
            unregisterClear();
        });

        it("the receiver of 'user-changed' runs the hooks too (the narrowed teardown)", async () => {
            const clearQueryCache = vi.fn();
            const unregister = registerSessionTeardownHook(clearQueryCache);
            authStore.setAuthenticated(true);
            authStore.setUnlocked(true);
            storeVaultKey("dGVzdA==");
            attachVaultSessionChannel();

            const sender = new BroadcastChannel("vault-session");
            sender.postMessage({ type: "user-changed", originTabId: "other-tab-simulated" });

            await vi.waitFor(() => {
                expect(getStoredVaultKey()).toBeNull();
            });
            expect(clearQueryCache).toHaveBeenCalledOnce();
            sender.close();
            unregister();
        });

        it("an unregistered hook no longer runs", () => {
            const hook = vi.fn();
            const unregister = registerSessionTeardownHook(hook);
            unregister();

            runSessionTeardownHooks();

            expect(hook).not.toHaveBeenCalled();
        });
    });

    it("performLogout calls API logout then teardownSession", async () => {
        storeVaultKey("dGVzdA==");
        await performLogout();

        expect(logoutApi).toHaveBeenCalledOnce();
        expect(getStoredVaultKey()).toBeNull();
        expect(authStore.isAuthenticated).toBe(false);
    });

    it("restoreSession unlocks from sessionStorage when worker ping fails", async () => {
        pingWorkerStatus.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        storeVaultKey("AAAAAAAAAAAAAAAAAAAAAA==");

        const restored = await restoreSession();

        expect(restored).toBe(true);
        expect(unlockWorker).toHaveBeenCalledOnce();
        expect(authStore.isAuthenticated).toBe(true);
        expect(authStore.isVaultUnlocked).toBe(true);
    });

    // A regression: the belt in item-service.ts / NoteAutosave.svelte.ts checks
    // isVaultSessionCurrent() before writing. A second tab in the same BrowserContext that unlocks
    // PURELY through a ping to an already-unlocked SharedWorker — never calling storeVaultKey itself —
    // has to count as a valid session: without this binding, that legitimate tab falsely fails with
    // "the session is not valid" (it caused a regression in e2e/27-multi-tab.spec.ts).
    it("restoreSession through a ping, with no local vault_key, binds the tab generation to the current one", async () => {
        // Somebody else — a sign-in in this browser, say — has already set the global generation.
        storeVaultKey("dGVzdA==");
        clearVaultKey(); // drop THIS tab's vault_key and tab generation — simulating a fresh second tab
        pingWorkerStatus.mockResolvedValueOnce(true); // the SharedWorker is already unlocked from another tab

        const restored = await restoreSession();

        expect(restored).toBe(true);
        expect(unlockWorker).not.toHaveBeenCalled();
        expect(isVaultSessionCurrent()).toBe(true);
    });

    // A worker busy building the search index answers no tab for seconds — not "locked".
    it("a ping that times out is asked again, patiently, and the tab stays signed in", async () => {
        storeVaultKey("dGVzdA==");
        clearVaultKey();
        pingWorkerStatus.mockResolvedValueOnce("timeout").mockResolvedValueOnce(true);

        const restored = await restoreSession();

        expect(restored).toBe(true);
        expect(pingWorkerStatus).toHaveBeenNthCalledWith(1);
        expect(pingWorkerStatus).toHaveBeenNthCalledWith(2, 20_000);
        expect(unlockWorker).not.toHaveBeenCalled();
        expect(isVaultSessionCurrent()).toBe(true);
    });

    it("a worker that answers 'locked' is taken at its word, with no second ping", async () => {
        pingWorkerStatus.mockResolvedValue(false);

        const restored = await restoreSession();

        expect(restored).toBe(false);
        expect(pingWorkerStatus).toHaveBeenCalledOnce();
    });

    it("a worker that never answers is given up on after the second timeout, without an INIT", async () => {
        storeVaultKey("AAAAAAAAAAAAAAAAAAAAAA==");
        pingWorkerStatus.mockResolvedValue("timeout");

        const restored = await restoreSession();

        expect(restored).toBe(false);
        expect(pingWorkerStatus).toHaveBeenCalledTimes(2);
        expect(unlockWorker).not.toHaveBeenCalled();
        expect(authStore.isVaultUnlocked).toBe(false);
    });

    it("handleUnauthorizedSession tears down vault once and redirects to login", async () => {
        authStore.setAuthenticated(true);
        authStore.setUnlocked(true);
        storeVaultKey("dGVzdA==");
        const assign = vi.fn();
        vi.stubGlobal("location", { assign, pathname: "/notes", search: "" });

        handleUnauthorizedSession("expired");
        handleUnauthorizedSession("expired"); // single-flight — the second call is a no-op

        // the teardown is async — wait for the microtasks plus the logoutWorker path
        await vi.waitFor(() => {
            expect(logoutWorker).toHaveBeenCalledOnce();
        });
        expect(getStoredVaultKey()).toBeNull();
        expect(authStore.isVaultUnlocked).toBe(false);
        expect(assign).toHaveBeenCalledWith(expect.stringContaining("/login?error=session_ended"));
        expect(assign).toHaveBeenCalledOnce();
        vi.unstubAllGlobals();
    });

    it("handleUnauthorizedSession locked reason uses account_locked query", async () => {
        authStore.setAuthenticated(true);
        authStore.setUnlocked(true);
        storeVaultKey("dGVzdA==");
        const assign = vi.fn();
        vi.stubGlobal("location", { assign, pathname: "/notes", search: "" });

        handleUnauthorizedSession("locked");
        await vi.waitFor(() => {
            expect(assign).toHaveBeenCalled();
        });
        expect(assign).toHaveBeenCalledWith(expect.stringContaining("error=account_locked"));
        vi.unstubAllGlobals();
    });

    it("restoreSession returns false when no stored key and worker is locked", async () => {
        pingWorkerStatus.mockResolvedValue(false);
        authStore.setAuthenticated(false);
        authStore.setUnlocked(false);

        const restored = await restoreSession();

        expect(restored).toBe(false);
        expect(authStore.isAuthenticated).toBe(false);
        expect(authStore.isVaultUnlocked).toBe(false);
    });

    // A second user signing in in the same browser rotates the session generation and tells the
    // other tabs through the new "user-changed" channel, rather than reusing "logout".
    describe("cross-tab user-changed", () => {
        it("an old tab, with an unchanged tab generation, stops treating the session as valid after a rotation", () => {
            // storeVaultKey binds THIS tab to the current generation — it simulates tab 1 before the
            // change of user. That tab generation is captured by comparing isVaultSessionCurrent()
            // BEFORE the rotation (do not assert on the login tab AFTER storeVaultKey,
            // because the login tab binds itself to the new generation again — here we deliberately
            // do NOT call storeVaultKey again).
            storeVaultKey("dGVzdA==");
            expect(isVaultSessionCurrent()).toBe(true);

            rotateSessionForUserChange();

            expect(isVaultSessionCurrent()).toBe(false);
        });

        it("broadcasts 'user-changed', not 'logout'", async () => {
            attachVaultSessionChannel();
            const received: unknown[] = [];
            const listener = new BroadcastChannel("vault-session");
            listener.onmessage = (e) => received.push(e.data);

            rotateSessionForUserChange();

            await vi.waitFor(() => {
                expect(received.length).toBeGreaterThan(0);
            });
            expect(received[0]).toMatchObject({ type: "user-changed" });
            listener.close();
        });

        // The receiver of "user-changed" MUST perform the narrowed teardown — a RAM cleanup plus
        // clearVaultKey — but NOT logoutWorker(), because the SharedWorker's owner is now the login
        // tab and a LOGOUT from this (old) tab would zeroize B's freshly set Vault Key.
        it("the receiver of 'user-changed' does a RAM cleanup + clearVaultKey, NOT logoutWorker", async () => {
            authStore.setAuthenticated(true);
            authStore.setUnlocked(true);
            storeVaultKey("dGVzdA==");
            attachVaultSessionChannel();

            const sender = new BroadcastChannel("vault-session");
            sender.postMessage({ type: "user-changed", originTabId: "other-tab-simulated" });

            await vi.waitFor(() => {
                expect(getStoredVaultKey()).toBeNull();
            });
            expect(authStore.isAuthenticated).toBe(false);
            expect(authStore.isVaultUnlocked).toBe(false);
            expect(flushIndex).toHaveBeenCalled();
            expect(logoutWorker).not.toHaveBeenCalled();
            sender.close();
        });

        // The receiver must not rotate the generation again — the sender has already done so
        // before the broadcast; a second rotation could throw the NEW (login) tab out.
        it("the receiver of 'user-changed' does not rotate the generation again", async () => {
            authStore.setAuthenticated(true);
            authStore.setUnlocked(true);
            storeVaultKey("dGVzdA==");
            attachVaultSessionChannel();
            const genBeforeReceive = localStorage.getItem("zknotes_session_gen");

            const sender = new BroadcastChannel("vault-session");
            sender.postMessage({ type: "user-changed", originTabId: "other-tab-simulated" });

            await vi.waitFor(() => {
                expect(getStoredVaultKey()).toBeNull();
            });
            expect(localStorage.getItem("zknotes_session_gen")).toBe(genBeforeReceive);
            sender.close();
        });

        // The logout path is unchanged — it still reuses the "logout" type and the full teardown.
        it("the receiver of 'logout' still performs the full teardown, logoutWorker included", async () => {
            authStore.setAuthenticated(true);
            authStore.setUnlocked(true);
            storeVaultKey("dGVzdA==");
            attachVaultSessionChannel();

            const sender = new BroadcastChannel("vault-session");
            sender.postMessage({ type: "logout", originTabId: "other-tab-simulated" });

            await vi.waitFor(() => {
                expect(logoutWorker).toHaveBeenCalledOnce();
            });
            expect(getStoredVaultKey()).toBeNull();
            sender.close();
        });
    });
});
