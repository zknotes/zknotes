import { API_BASE, ApiError, isGatewayDownStatus } from "$lib/core/api/client";
import { SECOND_MS } from "$lib/core/utils/duration";

/**
 * The runtime commercial data from GET /instance-config.
 * It is not in the bundle — the same build with a different `.env` has to produce the same
 * manifestHash. When a field is missing the UI simply does not render that line (a self-host, not an
 * error).
 */
export type InstancePublicConfig = {
    wwwUrl?: string;
    /** The Corresponding Source of what this instance serves (AGPL). */
    sourceUrl?: string;
    account?: { manageUrl?: string };
};

let cached: InstancePublicConfig | null = null;
let inflight: Promise<InstancePublicConfig> | null = null;

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** https always; http only in the Vite dev server. Invalid / other schemes → missing. */
function asPublicUrl(value: unknown): string | undefined {
    const v = asNonEmptyString(value);
    if (!v) return undefined;
    try {
        const protocol = new URL(v).protocol;
        if (protocol === "https:") return v;
        if (protocol === "http:" && import.meta.env.DEV) return v;
        return undefined;
    } catch {
        return undefined;
    }
}

function parseConfig(raw: unknown): InstancePublicConfig {
    if (!raw || typeof raw !== "object") return {};
    const obj = raw as Record<string, unknown>;
    const wwwUrl = asPublicUrl(obj.wwwUrl);
    const sourceUrl = asPublicUrl(obj.sourceUrl);
    const accountRaw = obj.account;
    const manageUrl =
        accountRaw && typeof accountRaw === "object"
            ? asPublicUrl((accountRaw as Record<string, unknown>).manageUrl)
            : undefined;
    return {
        ...(wwwUrl ? { wwwUrl } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(manageUrl ? { account: { manageUrl } } : {}),
    };
}

/** The last configuration loaded successfully, or `null` before the first success. */
export function getInstancePublicConfig(): InstancePublicConfig | null {
    return cached;
}

// Every request has to end: the sign-in screen asks again on its own while the server is away, and a
// server that accepts the connection but never answers would otherwise stall that loop for minutes.
const FETCH_TIMEOUT_MS = 10 * SECOND_MS;

/**
 * Asks GET /instance-config again, past the cache, and caches the answer. It **throws** when the
 * server cannot be reached — no connection, the timeout, or the proxy reporting the API down — which
 * makes it the sign-in screen's reachability probe: cheap, public and not rate limited. A server that
 * answers without a usable configuration (an older one) resolves to `{}`, which is not cached.
 */
export async function refreshInstancePublicConfig(): Promise<InstancePublicConfig> {
    const res = await fetch(`${API_BASE}/instance-config`, {
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (isGatewayDownStatus(res.status)) {
        throw new ApiError(res.statusText || "Bad Gateway", res.status);
    }
    if (!res.ok) return {};
    let raw: unknown;
    try {
        raw = await res.json();
    } catch {
        return {};
    }
    cached = parseConfig(raw);
    return cached;
}

/** Fetches (and caches) GET /instance-config. Never throws; a failure is not cached. */
export async function loadInstancePublicConfig(): Promise<InstancePublicConfig> {
    if (cached) return cached;
    if (inflight) return inflight;

    inflight = refreshInstancePublicConfig()
        .catch((): InstancePublicConfig => ({}))
        .finally(() => {
            inflight = null;
        });

    return inflight;
}
