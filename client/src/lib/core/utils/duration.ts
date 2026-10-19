/**
 * The time constants in milliseconds — pure numbers, with no CJS and no parse helper.
 *
 * A replacement for the `ms` package and a local parse helper: the production bundle used to merge
 * `import ms from "ms"` into the same chunk as the @zknotes/shared cryptography; the circular load
 * then gave a `TypeError: a is not a function` (or an undefined `.exec`) while the app shell mounted
 * after a login. Constants have no top-level calls, so they are safe in that graph.
 */

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;

/** The current time in whole seconds — the unit every `updated_at`/`created_at` in the vault uses. */
export function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}
