// The JSON API wrapper — deliberately free of SvelteKit dependencies (goto): the 401 handling goes
// through an injected handler that the root layout (routes/+layout.svelte) registers on mount. That
// keeps the module testable and usable outside a SvelteKit context (workers).

// The API is same-origin in dev and in production alike: the Vite proxy (dev) and Caddy's path routing
// (prod, docker/Caddyfile) send the API routes through the same host, so API_BASE is empty and the
// calls are relative. VITE_API_URL exists only as an escape hatch for non-standard setups (an API on
// another domain ⇒ it needs CORS).
export const API_BASE = import.meta.env.VITE_API_URL ?? "";

/** The session expired on a protected route — the global handler performs the redirect. */
export class UnauthorizedError extends Error {
    constructor() {
        super("Session expired");
        this.name = "UnauthorizedError";
    }
}

/** A typed API error carrying the HTTP status code, for classifying transient against permanent failures. */
export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        /** The parsed error body, when there was one — `max_file_size` on a 413, say. */
        public readonly body?: Record<string, unknown>,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

/**
 * A proxy in front of the API (Caddy in production, the Vite proxy in dev) answering that the API
 * behind it is down or did not reply in time. The API itself never sends these.
 */
export function isGatewayDownStatus(status: number): boolean {
    return status === 502 || status === 504;
}

// The exact error objects apiFetch rethrew because no response came back at all (no connection, the
// timeout ran out). They are rethrown unchanged — callers match on their type and message — and only
// remembered here, so a TypeError from a bug elsewhere is never mistaken for a network failure.
const noResponseErrors = new WeakSet<object>();

/**
 * Whether a failed request means the server could not be reached, as opposed to the server refusing
 * it. The first is worth retrying on its own and gets a plain explanation in the UI; the second
 * carries the server's own message.
 */
export function isServerUnreachableError(err: unknown): boolean {
    if (err instanceof ApiError) return isGatewayDownStatus(err.status);
    return typeof err === "object" && err !== null && noResponseErrors.has(err);
}

export async function extractError(res: Response): Promise<string> {
    try {
        const data = (await res.json()) as { error?: string };
        return data.error || res.statusText;
    } catch {
        return res.statusText;
    }
}

let onUnauthorized: ((reason?: "expired" | "locked") => void) | null = null;

/**
 * Registers the global 401/403 handler (in the root layout: `handleUnauthorizedSession` — a vault
 * teardown plus a redirect to /login). It is called ONLY for the non-/auth/ routes — a login with the
 * wrong password does not redirect.
 */
export function setUnauthorizedHandler(
    handler: ((reason?: "expired" | "locked") => void) | null,
): void {
    onUnauthorized = handler;
}

export type ApiFetchOptions = RequestInit & {
    /**
     * Gives up sooner than the default for a request the server answers in milliseconds, so a
     * server that accepts the connection but never replies is reported instead of waited on.
     * Ignored when the caller passes its own `signal`.
     */
    timeoutMs?: number;
};

export async function apiFetch<T>(endpoint: string, apiOptions: ApiFetchOptions = {}): Promise<T> {
    const { timeoutMs: callTimeoutMs, ...options } = apiOptions;
    // When explicitly offline, reject at once without trying the network.
    // That keeps the browser from printing an ugly red `net::ERR_INTERNET_DISCONNECTED` in the
    // console, which can make users think the application is broken when this is only a background
    // sync and everything is cached correctly in IndexedDB.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        const offline = new TypeError("Failed to fetch");
        noResponseErrors.add(offline);
        throw offline;
    }

    const timeoutMs = callTimeoutMs ?? (Number(import.meta.env.VITE_API_TIMEOUT_MS) || 30_000);
    const timeoutSignal =
        typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
            ? AbortSignal.timeout(timeoutMs)
            : undefined;
    const signal = options.signal ?? timeoutSignal;

    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
        res = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            signal,
            headers: {
                ...headers,
                ...options.headers,
            },
            credentials: "include", // Essential for HTTP-only cookies
        });
    } catch (err) {
        // A caller's own abort is a decision, not an outage — only our timeout counts.
        const timedOut = err instanceof DOMException && err.name === "TimeoutError";
        if ((err instanceof TypeError || timedOut) && !options.signal?.aborted) {
            noResponseErrors.add(err);
        }
        throw err;
    }

    if (!res.ok) {
        // The session expired on a protected route — the global handler performs the redirect.
        // The auth routes (/auth/*) return 401 for wrong credentials — do not treat that as an
        // expiry.
        if ((res.status === 401 || res.status === 403) && !endpoint.startsWith("/auth/")) {
            const reason = res.status === 403 ? "locked" : "expired";
            onUnauthorized?.(reason);
            throw new UnauthorizedError();
        }

        const errorMessage = await extractError(res);
        throw new ApiError(errorMessage || "API Request failed", res.status);
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
        return undefined as T;
    }
    return res.json();
}
