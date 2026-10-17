// A generic keyed pub/sub (the Observer pattern) — subscribers listen on one key (a fileId, say) and
// an emit targets that key. One leak-safe implementation of the subscribe/emit lifecycle: an empty
// listener set is deleted so the Map does not grow. Previously hand-repeated in file-invalidator.ts
// and upload-manager.ts.
//
// Note: this is NOT the same as files-changed-bus.ts (`makeChannel`) — that is a coalesced batch
// stream, where every listener receives a set of ids; this is keyed by id, where a listener follows
// one key. They are deliberately separate.

export interface KeyedChannel<A = void> {
    /** Subscribes `cb` to changes of `key`; it returns an unsubscribe function. */
    on(key: string, cb: (arg: A) => void): () => void;
    /** Calls every subscriber of `key`. */
    emit(key: string, arg: A): void;
}

export function createKeyedChannel<A = void>(): KeyedChannel<A> {
    const subs = new Map<string, Set<(arg: A) => void>>();

    return {
        on(key, cb) {
            let set = subs.get(key);
            if (!set) {
                set = new Set();
                subs.set(key, set);
            }
            set.add(cb);
            return () => {
                set.delete(cb);
                if (set.size === 0) subs.delete(key);
            };
        },
        emit(key, arg) {
            const set = subs.get(key);
            // The copy ([...set]) allows an unsubscribe from inside a callback without mutating during iteration.
            if (set) for (const cb of [...set]) cb(arg);
        },
    };
}
