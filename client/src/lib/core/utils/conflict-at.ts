/** Normalises a timestamp to unix seconds (a guard against millisecond values). */
export function normalizeConflictAt(at: number): number {
    return at > 1e11 ? Math.floor(at / 1000) : at;
}
