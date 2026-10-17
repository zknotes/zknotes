import { globalToasts } from "$lib/core/stores/toast.svelte";

/** Once per page load — the (app) layout can remount (login ↔ vault). */
let initialized = false;

/** The active update toast (durationMs: 0) — do not show a second one for the same or a newer waiting SW. */
let updateToastId: string | null = null;

/** The last waiting worker; Reload sends SKIP_WAITING to it (a newer one can replace it). */
let pendingWorker: ServiceWorker | null = null;

/**
 * Registers the SW update UX: the toast "A new version is available — Reload".
 * Idempotent — safe to call from onMount and after a remount.
 */
export function initServiceWorkerUpdate() {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    if (!import.meta.env.PROD) return;
    if (initialized) return;
    initialized = true;

    // A reload is justified only when a NEW worker replaces an EXISTING one — that is, after a user's
    // "Reload" in the toast. On a first visit the page is not controlled, so the first clients.claim()
    // also emits controllerchange; an unconditional reload there was an unexplained refresh.
    const wasControlled = !!navigator.serviceWorker.controller;

    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!wasControlled) return;
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
    });

    function showUpdateToast(worker: ServiceWorker) {
        // Always remember the newest waiting worker, in case another update arrives.
        pendingWorker = worker;
        // Already shown — do not duplicate it (waiting plus updatefound→installed, or a remount).
        if (updateToastId) return;

        updateToastId = globalToasts.add({
            message: "A new version is available — Reload",
            variant: "info",
            durationMs: 0,
            action: {
                label: "Reload",
                onClick: () => {
                    pendingWorker?.postMessage({ type: "SKIP_WAITING" });
                },
            },
        });
    }

    /** Follows the SW to "installed"; immediately when it is already waiting. */
    function watchWorker(worker: ServiceWorker | null) {
        if (!worker) return;
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateToast(worker);
            return;
        }
        worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
                showUpdateToast(worker);
            }
        });
    }

    navigator.serviceWorker
        .register("/service-worker.js", { type: "module" })
        .then((registration) => {
            // Already waiting for activation (a previous visit, or a background update).
            watchWorker(registration.waiting);
            // An install is in progress — updatefound may have passed before our listener.
            watchWorker(registration.installing);

            registration.addEventListener("updatefound", () => {
                watchWorker(registration.installing);
            });
        })
        .catch((e) => {
            console.warn("Service worker registration failed", e);
        });
}
