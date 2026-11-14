// OpenTimestamps calendar client: the server's only outbound call for seals.
//
// The client never names a URL. `POST /seals` fans a 32-byte commitment out to every calendar on the
// instance's own list (`OTS_CALENDAR_URLS`), and an upgrade asks only calendars on that list, so the
// route offers no way to make the server fetch an address of the caller's choosing. Responses are
// opaque bytes to the server: it bounds their size and time and hands them back; the client parses
// and merges them into its encrypted proof.
//
// Nothing here logs a commitment or a message — not in an error, not at debug level. They reveal no
// content, but they are the link between a user and a public calendar entry.

/** The calendars a fresh instance uses: the three OpenTimestamps project calendars and Catallaxy. */
export const DEFAULT_OTS_CALENDARS = [
    "https://alice.btc.calendar.opentimestamps.org",
    "https://bob.btc.calendar.opentimestamps.org",
    "https://finney.calendar.eternitywall.com",
    "https://btc.calendar.catallaxy.com",
] as const;

/** A calendar reply is a few hundred bytes pending and a few KiB confirmed; this is a hard cap. */
export const MAX_CALENDAR_REPLY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ACCEPT = "application/vnd.opentimestamps.v1";

export type CalendarFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The instance's calendar list. Unset → the defaults; set to an empty string → none, which turns
 * sealing off on this instance. Only `https:` is accepted, plus `http:` outside production (a local
 * fake calendar in tests). Invalid entries are dropped; duplicates collapse.
 */
export function calendarUrls(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.OTS_CALENDAR_URLS;
    if (raw === undefined) return [...DEFAULT_OTS_CALENDARS];
    const out: string[] = [];
    for (const entry of raw.split(/[\s,]+/)) {
        const url = normalizeCalendarUrl(entry, env.NODE_ENV === "production");
        if (url && !out.includes(url)) out.push(url);
    }
    return out;
}

/** `origin + path` without a trailing slash, or null for anything that is not a plain http(s) URL. */
export function normalizeCalendarUrl(raw: string, production: boolean): string | null {
    if (!raw) return null;
    try {
        const url = new URL(raw);
        const okProtocol = url.protocol === "https:" || (!production && url.protocol === "http:");
        if (!okProtocol || url.username || url.password || url.search || url.hash) return null;
        return url.origin + url.pathname.replace(/\/+$/, "");
    } catch {
        return null;
    }
}

async function readCapped(res: Response): Promise<Uint8Array | null> {
    const declared = Number(res.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > MAX_CALENDAR_REPLY_BYTES) return null;
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_CALENDAR_REPLY_BYTES) {
            await reader.cancel().catch(() => {});
            return null;
        }
        parts.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.byteLength;
    }
    return out;
}

type CallOpts = { fetch?: CalendarFetch; timeoutMs?: number };

async function call(
    url: string,
    init: RequestInit,
    opts: CallOpts,
): Promise<{ status: number; body: Uint8Array | null } | null> {
    const doFetch = opts.fetch ?? (fetch as CalendarFetch);
    try {
        const res = await doFetch(url, {
            ...init,
            // A redirect could point anywhere; a calendar has no reason to send one.
            redirect: "error",
            signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            headers: { Accept: ACCEPT, "User-Agent": "zknotes-seal", ...init.headers },
        });
        const body = res.ok ? await readCapped(res) : null;
        if (!res.ok) await res.body?.cancel().catch(() => {});
        return { status: res.status, body };
    } catch {
        return null;
    }
}

export type SubmitResult = { calendar: string } & ({ ok: true; body: Uint8Array } | { ok: false });

/** Sends the commitment to every calendar at once. One success is enough for a seal. */
export async function submitCommitment(
    commitment: Uint8Array,
    calendars: readonly string[],
    opts: CallOpts = {},
): Promise<SubmitResult[]> {
    return Promise.all(
        calendars.map(async (calendar): Promise<SubmitResult> => {
            const res = await call(
                `${calendar}/digest`,
                {
                    method: "POST",
                    body: commitment as Uint8Array<ArrayBuffer>,
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                },
                opts,
            );
            if (res?.status === 200 && res.body && res.body.byteLength > 0) {
                return { calendar, ok: true, body: res.body };
            }
            return { calendar, ok: false };
        }),
    );
}

export type UpgradeResult = { calendar: string; message: string } & (
    | { status: "confirmed"; body: Uint8Array }
    | { status: "pending" | "error" | "skipped" }
);

/**
 * Asks each calendar for the completed timestamp of the message at its pending attestation. A 404
 * is the calendar's ordinary "not in a block yet". A calendar that is not on the instance's list is
 * skipped, never contacted.
 */
export async function fetchUpgrades(
    attestations: ReadonlyArray<{ calendar: string; message: string }>,
    calendars: readonly string[],
    opts: CallOpts = {},
): Promise<UpgradeResult[]> {
    return Promise.all(
        attestations.map(async ({ calendar, message }): Promise<UpgradeResult> => {
            const known = normalizeCalendarUrl(calendar, false);
            if (!known || !calendars.includes(known))
                return { calendar, message, status: "skipped" };
            const res = await call(`${known}/timestamp/${message}`, { method: "GET" }, opts);
            if (res?.status === 200 && res.body && res.body.byteLength > 0) {
                return { calendar, message, status: "confirmed", body: res.body };
            }
            if (res?.status === 404) return { calendar, message, status: "pending" };
            return { calendar, message, status: "error" };
        }),
    );
}
