/**
 * Parses a numeric query parameter and clamps it to [min, max].
 * Invalid or absent input falls back to defaultValue instead of reaching SQL.
 */
export function parsePositiveIntParam(
    value: string | undefined,
    opts: { defaultValue: number; min: number; max: number },
): number {
    if (!value) return opts.defaultValue;
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return opts.defaultValue;
    return Math.max(opts.min, Math.min(parsed, opts.max));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID (v4/v7: hex plus dashes) — rejects a Postgres cast error before it becomes a 500. */
export function isUuid(value: string): boolean {
    return UUID_RE.test(value);
}
