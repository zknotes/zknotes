/** Unix time in seconds — the only definition (DB timestamps are integer seconds). */
export function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

/** The default safety window for the issued delta-pull watermark. */
const DEFAULT_WATERMARK_SAFETY_MS = 30_000;

/**
 * How far the issued `server_time` deliberately lags behind the real time.
 *
 * `updated_at` is stamped with `nowSec()` in the Node handler, not at commit time. A transaction
 * (a large `POST /items/batch`, say) that commits after the client already received a watermark
 * carrying an `updated_at` from an earlier second stays invisible in the next pull.
 * This is a bound within `statement_timeout` / `idle_in_transaction_session_timeout`, not a proof —
 * a longer transaction can still lose rows.
 */
export function watermarkSafetyMs(): number {
    const raw = process.env.SYNC_WATERMARK_SAFETY_MS;
    if (raw === undefined || raw === "") return DEFAULT_WATERMARK_SAFETY_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_WATERMARK_SAFETY_MS;
    return n;
}

/** The watermark the client stores: `captured − safety`, never negative. */
export function issuedWatermarkMs(capturedMs: number): number {
    return Math.max(0, capturedMs - watermarkSafetyMs());
}

/**
 * Converts a millisecond timestamp string into seconds (for query parameters).
 * Returns null if the string is not a valid number.
 */
export function parseTimestampParam(value: string | undefined): number | null {
    if (!value) return null;
    const ms = parseInt(value, 10);
    if (Number.isNaN(ms)) return null;
    return Math.floor(ms / 1000);
}

/**
 * Clamps the client's `deleted_at` to the server's "now".
 *
 * `deleted_at` is the only trash timestamp the client may send (synced trash), and the GC
 * retention sweep uses it in its arithmetic (`deleted_at < now - TRASH_RETENTION_DAYS`). Without a
 * clamp, a client with a skewed clock (or a malicious one) sends a `deleted_at` in the future → the
 * item never ripens for the retention purge → "immortal trash" (the blob is never released from
 * object storage).
 *
 * Past timestamps are legitimate (an offline device syncing trash from N days ago) and are left
 * untouched; only the future is clamped. A silent clamp rather than a rejection — a few seconds of
 * skew is normal.
 */
export function clampDeletedAt(
    value: number | null | undefined,
    now: number = nowSec(),
): number | null {
    if (value == null) return null;
    return Math.min(value, now);
}
