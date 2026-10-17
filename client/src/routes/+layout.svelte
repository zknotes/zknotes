<script lang="ts">
import "../app.css";
import { QueryClient, setQueryClientContext } from "@tanstack/svelte-query";
import { onMount } from "svelte";
import { page } from "$app/state";
import { authStore } from "$lib/core/stores/auth-store.svelte";
import { themeStore } from "$lib/core/stores/theme.svelte";
import { uiZoomStore } from "$lib/core/stores/ui-zoom.svelte";
import { pwaStore } from "$lib/core/stores/pwa.svelte";
import { syncStore } from "$lib/core/sync/store.svelte";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import Toast from "$lib/core/ui/Toast.svelte";
import { setUnauthorizedHandler } from "$lib/core/api";
import {
    attachVaultSessionChannel,
    handleUnauthorizedSession,
    registerSessionTeardownHook,
    restoreSession,
} from "$lib/core/services/session-service";
import { MINUTE_MS } from "$lib/core/utils/duration";
import { isRestoreBlockingUnload } from "$lib/modules/export/restore-wizard";
import { isUploadBlockingUnload } from "$lib/modules/files/upload-manager";
import type { Component, Snippet } from "svelte";

let StorageInspector = $state<Component | null>(null);
// Dev-only, like the storage inspector: a static import compiled the panel into the production
// bundle even though it renders nothing there.
let DevPanel = $state<Component<{ storageInspector?: Snippet }> | null>(null);

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 5 * MINUTE_MS,
            networkMode: "always",
        },
        mutations: {
            networkMode: "always",
        },
    },
});

setQueryClientContext(queryClient);

onMount(() => {
    const loader = document.getElementById("initial-loader");
    if (loader) {
        // Fade out transition
        loader.style.opacity = "0";
        setTimeout(() => loader.remove(), 400);
    }

    themeStore.init();
    uiZoomStore.init();
    pwaStore.init();
    // A 401/403 → tear the vault down (not merely a redirect). Early, not only in the (app) layout.
    setUnauthorizedHandler((reason) => handleUnauthorizedSession(reason));
    // The cross-tab logout listener (BroadcastChannel) — before restoreSession.
    attachVaultSessionChannel();
    // The query cache holds decrypted note HTML and titles; it is created once here and survives
    // SPA navigation to /login, so it has to be part of the session teardown (logout, 401,
    // user-changed) — otherwise the plaintext outlives the vault key and the next user's tree
    // query is served the previous user's titles from the cache.
    const unregisterTeardownHook = registerSessionTeardownHook(() => queryClient.clear());

    if (import.meta.env.DEV) {
        import("$lib/modules/files/dev/DevStorageInspector.svelte").then((m) => {
            StorageInspector = m.default;
        });
        import("$lib/core/ui/dev/DevPanel.svelte").then((m) => {
            DevPanel = m.default;
        });
    }

    (async () => {
        authStore.isChecking = true;
        try {
            await restoreSession();
        } catch (e) {
            console.error("Failed to restore session", e);
        } finally {
            authStore.isChecking = false;
        }
    })();

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (syncStore.pendingCount > 0) {
            e.preventDefault();
            e.returnValue = "You have unsynced changes. Are you sure you want to leave?";
            return e.returnValue;
        }
        if (isUploadBlockingUnload()) {
            e.preventDefault();
            e.returnValue = "File uploads are in progress. Are you sure you want to leave?";
            return e.returnValue;
        }
        if (isRestoreBlockingUnload()) {
            e.preventDefault();
            e.returnValue = "A restore is in progress. Are you sure you want to leave?";
            return e.returnValue;
        }
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
        unregisterTeardownHook();
        window.removeEventListener("beforeunload", onBeforeUnload);
    };
});

let { children } = $props();
</script>

{#if authStore.isChecking && !page.url.pathname.startsWith('/dev')}
    <div class="fixed inset-0 flex items-center justify-center bg-[var(--surface-app)] bg-grid text-[var(--text)]">
        <div class="flex flex-col items-center">
            <div class="w-10 h-10 rounded-full border-2 border-brand0 border-t-transparent animate-spin mb-4"></div>
            <p class="text-2xs font-mono uppercase tracking-[0.18em] text-brand-fg/80">Securing connection…</p>
        </div>
    </div>
{:else}
    {@render children()}
{/if}

{#snippet storageInspectorSnippet()}
    {#if StorageInspector}
        <StorageInspector />
    {/if}
{/snippet}

{#if DevPanel}
    <DevPanel storageInspector={storageInspectorSnippet} />
{/if}

<div class="toast-stack z-[100]">
	{#each globalToasts.toasts as toast (toast.id)}
		<div class="relative pointer-events-auto">
			<Toast
				variant={toast.variant}
				message={toast.message}
				action={toast.action}
				onDismiss={() => globalToasts.remove(toast.id)}
			/>
		</div>
	{/each}
</div>
