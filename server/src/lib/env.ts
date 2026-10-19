// A positive number from the environment, or the fallback: for ceilings and limits where "unset",
// "0" and garbage must all mean "use the default". Three modules used to carry this parse each.
export function envPositiveNumber(key: string, fallback: number): number {
    const raw = process.env[key];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
