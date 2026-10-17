/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="webworker" />

declare let self: ServiceWorkerGlobalScope;

// @ts-expect-error
import type { RequestStreamMessage, StreamResponseMessage } from "$lib/core/streaming/sw-bridge";
import { build, files, version } from "$service-worker";
import { serverUnreachableResponse } from "$lib/core/services/server-unreachable-page";

// ── App-shell precache (PWA, offline cold start) ─────────────────────────────
// The ZERO-KNOWLEDGE boundary: ONLY the static app shell goes into Cache Storage
// (the build artefacts: JS/CSS/HTML + the static files). Plaintext and encrypted blobs stay in
// IndexedDB; API responses (/items, /files, /auth, /me…) are NEVER cached (see `isApiRequest` plus the
// network-only branches in the fetch handler).
const CACHE_NAME = `zknotes-shell-${version}`;

// `build` = the hashed Vite chunks, `files` = the contents of static/. Both are immutable.
const PRECACHE = [...build, ...files];
const PRECACHE_PATHS = new Set(PRECACHE);

// Only a production build can start from the cache: its chunks are precached. A dev server's
// modules never are (`build` is empty there), so its cached shell would load nothing offline.
const CAN_BOOT_FROM_CACHE = build.length > 0;

// The stable key under which the last successful navigation (HTML) response is kept — the app-shell
// fallback for an offline cold start. The document is generic (the whole (app) zone is ssr=false), so
// it contains no plaintext.
const APP_SHELL_KEY = "/__app_shell__";

// Same-origin API prefixes (the dev Vite proxy / Caddy path routing in production).
// All of this is network-only, never cached. Keep it in step with the vite.config.ts proxy
// and the @api matcher in docker/Caddyfile.
const API_PREFIXES = [
    "/auth",
    "/vault",
    "/items",
    "/restore",
    "/uploads",
    "/me",
    "/shares",
    "/instance-config",
    "/client-log",
    "/client-error",
    "/dev-log",
    "/dev-logs",
    "/health",
];

function isApiRequest(url: URL): boolean {
    return API_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`));
}

const STREAM_SECURITY_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
};

// Install: precache the app shell, then activate immediately. (In dev, build/files are empty — an
// addAll([]) is a no-op; the precache only means anything on a production build.)
// skipWaiting: the video stream (`/zknotes/stream/`) works ONLY with an active controller — without
// this, the first load after registration waits for the tab to close before claiming, and in the
// meantime the player gets a 404 and falls back to a file chip.
self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_NAME);
            await cache.addAll(PRECACHE);
            // The SPA fallback (index.html) is NOT part of build/files. Fetch it proactively and
            // store it as the app shell, so an offline cold start works even with no previous
            // SW-controlled navigations. A generic document (ssr=false) — with no plaintext.
            try {
                const shell = await fetch("/", { cache: "no-store" });
                if (shell.ok) await cache.put(APP_SHELL_KEY, shell.clone());
            } catch {
                // offline during the install — the app shell fills up on the first online navigation
            }
            // skipWaiting only on a first install, with no active clients — a background update
            // waits for the user's confirmation.
            const clients = await self.clients.matchAll({ includeUncontrolled: true });
            if (clients.length === 0) {
                await self.skipWaiting();
            }
        })(),
    );
});

self.addEventListener("message", (event) => {
    // Only pages of this origin can reach a service worker today; the check keeps it that way.
    if (event.origin !== self.location.origin) return;
    if (event.data && event.data.type === "SKIP_WAITING") {
        self.skipWaiting();
    }
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            // Delete the caches of older versions — no stale app-shell version gets stuck.
            for (const key of await caches.keys()) {
                if (key !== CACHE_NAME) await caches.delete(key);
            }
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // 1) The file streaming bridge — it MUST come before the app-shell branch (a stream URL must not
    //    end up in the cache or the SPA fallback).
    if (url.pathname.startsWith("/zknotes/stream/")) {
        const fileId = url.pathname.split("/").pop();
        if (fileId) {
            event.respondWith(handleStream(fileId, event.request, event.clientId));
        }
        return;
    }

    // 2) Network-only: non-GET, cross-origin (an API on another host) and the same-origin
    //    the API routes. We do not call respondWith → the browser does its default network fetch.
    if (
        event.request.method !== "GET" ||
        url.origin !== self.location.origin ||
        isApiRequest(url)
    ) {
        return;
    }

    // 3) The static app shell (the precache plus navigations) → cache-aware.
    event.respondWith(handleAppShell(event.request, url));
});

/**
 * The app-shell strategy (same-origin GET only, non-API):
 * - A precached build/static asset (hashed, immutable) → cache-first.
 * - A navigation (HTML) → network-first; a success is cached as the app shell, and offline
 *   falls back to the last cached shell. That is how a second visit with no network still loads the app.
 * - Everything else → the network, then a cache fallback.
 */
async function handleAppShell(request: Request, url: URL): Promise<Response> {
    const cache = await caches.open(CACHE_NAME);

    if (PRECACHE_PATHS.has(url.pathname)) {
        const cached = await cache.match(url.pathname);
        if (cached) return cached;
    }

    if (request.mode === "navigate") {
        try {
            const res = await fetch(request);
            // Cache an OK navigation as the app shell (same-origin is guaranteed above; ssr=false → no plaintext).
            if (res.ok) cache.put(APP_SHELL_KEY, res.clone());
            return res;
        } catch {
            if (CAN_BOOT_FROM_CACHE) {
                const shell =
                    (await cache.match(APP_SHELL_KEY)) ?? (await cache.match(url.pathname));
                if (shell) return shell;
            }
            // Nothing here can start the app: say so, and come back by itself once the server answers.
            return serverUnreachableResponse();
        }
    }

    try {
        const res = await fetch(request);
        // A runtime cache ONLY for the hashed immutable Vite chunks (the app shell). Never an arbitrary
        // same-origin GET — that would regress the zero-knowledge boundary (API metadata, or stray
        // paths). The install precache already fills PRECACHE_PATHS; here we only top up
        // /_app/immutable/*
        // ones that are not on the install list (a lazy chunk after a navigation, say).
        if (res.ok && url.pathname.includes("/_app/immutable/")) {
            void cache.put(request, res.clone());
        }
        return res;
    } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        return new Response("offline: resource not cached", { status: 503 });
    }
}

function swLog(msg: string, data?: unknown) {
    if (import.meta.env && !import.meta.env.DEV) return;
    console.log(`[SW] ${msg}`, data || "");
}

async function handleStream(fileId: string, request: Request, clientId: string): Promise<Response> {
    swLog(`Intercepted stream request for ${fileId}`);

    // Prefer the page that issued the fetch — matchAll()'s order is arbitrary and can pick a stale or
    // bfcached window with no stream bridge listener, which would simply time out.
    let client = clientId ? await self.clients.get(clientId) : undefined;
    if (!client) {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        client = clients[0];
    }
    if (!client) {
        swLog("No active window to handle decryption");
        return new Response("No active window to handle decryption", { status: 503 });
    }
    swLog(`Found active window client: ${client.id}`);

    return new Promise((resolve, _reject) => {
        let attempts = 0;
        let interval: ReturnType<typeof setInterval>;
        let resolved = false;

        const reqId = Math.random().toString(36).slice(2);
        swLog(`Created stream reqId: ${reqId}`);

        // The handshake includes getFilePayload plus peekSniff (chunk 0 off the network). After a
        // large file is uploaded the local cache is empty → 5 s is too short, the media gets a 504,
        // and it falls back to a chip.
        const timeout = setTimeout(() => {
            clearInterval(interval);
            if (!resolved) {
                resolved = true;
                swLog(`Timeout waiting for main thread! reqId: ${reqId}`);
                resolve(
                    new Response("Timeout waiting for main thread", {
                        status: 504,
                        headers: STREAM_SECURITY_HEADERS,
                    }),
                );
            }
        }, 60_000);

        const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => {
            headers[key] = value;
        });

        const sendMsg = () => {
            if (resolved) return;
            const channel = new MessageChannel();
            channel.port1.onmessage = (e: MessageEvent<StreamResponseMessage>) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                clearInterval(interval);

                if (e.data.type === "STREAM_READY") {
                    const { stream, mime, size, range } = e.data;
                    const headers: Record<string, string> = {
                        "Content-Type": mime,
                        "Accept-Ranges": "bytes",
                        ...STREAM_SECURITY_HEADERS,
                    };
                    if (range) {
                        headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
                        headers["Content-Length"] = String(range.end - range.start + 1);
                    } else {
                        headers["Content-Length"] = String(size);
                    }
                    resolve(new Response(stream, { status: range ? 206 : 200, headers }));
                } else if (e.data.type === "STREAM_ERROR") {
                    const headers: Record<string, string> = { ...STREAM_SECURITY_HEADERS };
                    if (e.data.status === 416 && e.data.totalSize !== undefined) {
                        headers["Content-Range"] = `bytes */${e.data.totalSize}`;
                    }
                    resolve(new Response(e.data.error, { status: e.data.status ?? 500, headers }));
                }
            };

            const msg: RequestStreamMessage = {
                type: "REQUEST_STREAM",
                fileId,
                reqId,
                headers,
            };
            client.postMessage(msg, [channel.port2]);
        };

        sendMsg();
        interval = setInterval(() => {
            attempts++;
            if (attempts < 10) sendMsg();
        }, 500);
    });
}
