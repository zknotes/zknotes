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
