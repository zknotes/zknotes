/**
 * Persistent storage (anti-eviction) — without `navigator.storage.persist()`,
 * IndexedDB is "best effort", so the OS can silently clear it under memory pressure (Safari and iOS
 * especially), which breaks the offline-first guarantee and becomes critical once `file-chunks` start
 * taking up space. We request durable persistence once after the first successful unlock (or a PWA
 * install) and remember the outcome for the Settings hint.
 */
import { loadPersisted, STORAGE_KEYS, savePersisted } from "$lib/core/utils/persisted";

export type PersistOutcome = "persisted" | "denied" | "unsupported";

// A raw-string serde typed as PersistOutcome (the value is already in the union).
const outcomeSerde = {
    serialize: (v: PersistOutcome): string => v,
    deserialize: (raw: string): PersistOutcome => raw as PersistOutcome,
};

// The real request is made at most once per load — the other calls return the remembered outcome.
let attempted = false;

/** The last remembered outcome (for the Settings hint); "unsupported" when nothing has been requested yet. */
export function loadPersistOutcome(): PersistOutcome {
    return loadPersisted(STORAGE_KEYS.persistentStorage, "unsupported", outcomeSerde);
}

function remember(outcome: PersistOutcome): PersistOutcome {
    savePersisted(STORAGE_KEYS.persistentStorage, outcome, outcomeSerde);
    return outcome;
}

/**
 * Idempotently requests durable IDB persistence. It returns the outcome and remembers it.
 * Safe to call repeatedly (on every unlock, say) — it touches neither the network nor the API.
 */
export async function requestPersistentStorage(): Promise<PersistOutcome> {
    if (attempted) return loadPersistOutcome();
    attempted = true;

    if (typeof navigator === "undefined" || !navigator.storage?.persist) {
        return remember("unsupported");
    }

    try {
        // If it is already durable (after a PWA install, say) — do not ask again.
        const already = (await navigator.storage.persisted?.()) ?? false;
        const granted = already || (await navigator.storage.persist());
        const outcome: PersistOutcome = granted ? "persisted" : "denied";
        console.log(`[storage] persistent storage: ${outcome}`);
        return remember(outcome);
    } catch (e) {
        console.warn("[storage] persist() request failed", e);
        return remember("denied");
    }
}
