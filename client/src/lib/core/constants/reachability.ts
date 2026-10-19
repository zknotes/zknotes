// How the client treats a server that is away: the retry schedule the sign-in screen and the
// service worker's "server unreachable" page share, and the timeout for a request the server
// answers in milliseconds (a stalled server accepts the connection and never replies).
import { SECOND_MS } from "$lib/core/utils/duration";

/** Seconds before each automatic retry; the last one repeats. */
export const RETRY_DELAYS_S: readonly number[] = [2, 4, 8, 15];

/** A cheap, public probe (kdf-params, instance-config, the SW's own check) gets this long to answer. */
export const PROBE_TIMEOUT_MS = 10 * SECOND_MS;
