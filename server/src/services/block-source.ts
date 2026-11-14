// Block headers for seals: the server relays one 80-byte Bitcoin block header by height, so a
// client can show when the block that anchors a seal was mined. The server does not judge the
// header — the client checks its proof of work and its Merkle root against the seal's own proof,
// so a lying source cannot put a false time on a seal.
//
// The source is an Esplora-compatible API (`/block-height/:h`, `/block/:hash/header`), set by
// OTS_BLOCK_SOURCE_URL. Unset → blockstream.info; empty → off. The source sees only block heights,
// from the server's address; the client never names a URL.
import { normalizeCalendarUrl } from "./ots-calendar";

export const DEFAULT_BLOCK_SOURCE = "https://blockstream.info/api";
const TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 1024;
const MAX_HEIGHT = 2 ** 32 - 1;
const CACHE_MAX = 500;

/** Headers by height. A header deep enough to anchor a seal does not change; the cache is bounded. */
const cache = new Map<number, string>();

export type BlockFetch = (input: string, init: RequestInit) => Promise<Response>;

export function blockSourceUrl(env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = env.OTS_BLOCK_SOURCE_URL;
    if (raw === undefined) return DEFAULT_BLOCK_SOURCE;
    return normalizeCalendarUrl(raw.trim(), env.NODE_ENV === "production");
}

export function isBlockHeight(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= MAX_HEIGHT
    );
}

async function getText(url: string, doFetch: BlockFetch): Promise<string | null> {
    try {
        const res = await doFetch(url, {
            redirect: "error",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { Accept: "text/plain", "User-Agent": "zknotes-seal" },
        });
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            return null;
        }
        const body = await res.arrayBuffer();
        if (body.byteLength > MAX_REPLY_BYTES) return null;
        return new TextDecoder().decode(body).trim();
    } catch {
        return null;
    }
}

/** The 80-byte header of the block at `height`, as 160 lowercase hex digits; null when unavailable. */
export async function fetchBlockHeader(
    height: number,
    base: string,
    doFetch: BlockFetch = fetch as BlockFetch,
): Promise<string | null> {
    const cached = cache.get(height);
    if (cached) return cached;
    const hash = (await getText(`${base}/block-height/${height}`, doFetch))?.toLowerCase();
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
    const header = (await getText(`${base}/block/${hash}/header`, doFetch))?.toLowerCase();
    if (!header || !/^[0-9a-f]{160}$/.test(header)) return null;
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(height, header);
    return header;
}

/** Tests only: the cache is module state. */
export function __clearBlockHeaderCache(): void {
    cache.clear();
}
