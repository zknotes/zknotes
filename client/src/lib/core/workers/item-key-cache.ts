// The LRU cache of Item Keys inside the crypto worker. Lifted out of crypto.worker.ts into its own
// module so it is testable without a worker context — crypto.worker.ts remains the only place that
// instantiates it, and the only place where key material exists at all.
import { zeroize } from "@zknotes/shared";

export const MAX_CACHED_ITEM_KEYS = 500;

/**
 * A `set` on an EXISTING key has to move its position to the end (most recently used) — `Map.set` on
 * an existing key does NOT change its iteration order, so the old code
 * (`itemKeys.set(id, ik)` with no preceding `delete`) was FIFO by first insertion, not a real LRU.
 * The consequence: two parallel consumers re-adding the same key (rebuildIndex +
 * getTreeItems on the same item) could see it evicted before DECRYPT_PAYLOAD arrived.
 */
export class ItemKeyCache {
    #keys = new Map<string, Uint8Array>();
    #maxSize: number;

    constructor(maxSize: number = MAX_CACHED_ITEM_KEYS) {
        this.#maxSize = maxSize;
    }

    get size(): number {
        return this.#keys.size;
    }

    has(itemId: string): boolean {
        return this.#keys.has(itemId);
    }

    get(itemId: string): Uint8Array | undefined {
        const key = this.#keys.get(itemId);
        if (!key) return undefined;
        // An LRU touch on read — otherwise a hot key (ENCRYPT/DECRYPT/share) stays at the head of the
        // insertion order and is evicted while cold keys are kept.
        this.#keys.delete(itemId);
        this.#keys.set(itemId, key);
        return key;
    }

    set(itemId: string, key: Uint8Array): void {
        const prev = this.#keys.get(itemId);
        if (prev) {
            // Delete it and insert it again — a Map's iteration order is the insertion order, so this
            // moves an existing key to the end (an LRU "use" = a "refresh").
            this.#keys.delete(itemId);
        } else if (this.#keys.size >= this.#maxSize) {
            const oldestId = this.#keys.keys().next().value;
            if (oldestId !== undefined) {
                const oldest = this.#keys.get(oldestId);
                if (oldest) zeroize(oldest);
                this.#keys.delete(oldestId);
            }
        }
        this.#keys.set(itemId, key);
        // `!==` is required: crypto.worker re-sets a reference still in use for decrypt.
        if (prev && prev !== key) zeroize(prev);
    }

    /** Zeroizes and deletes EVERY key (logout or re-login). */
    clear(): void {
        this.#keys.forEach((key) => {
            zeroize(key);
        });
        this.#keys.clear();
    }
}
