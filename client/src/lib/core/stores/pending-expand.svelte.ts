/**
 * The folders the tree should expand by itself (runes).
 * Set after a create or a reveal: the whole ancestor path, not only the parent, so a collapsed A/B/C
 * still shows the new item with its rename.
 * Each FolderItem consumes its own id and expands.
 */
class PendingExpandStore {
    /** The reactive set of ids waiting to be expanded in the UI. */
    ids = $state<ReadonlySet<string>>(new Set());

    /** Is this folder queued for an expand? */
    has(id: string): boolean {
        return this.ids.has(id);
    }

    /** Adds one or more folders (a merge, not a replacement). */
    request(ids: Iterable<string>): void {
        const next = new Set(this.ids);
        let changed = false;
        for (const id of ids) {
            if (!next.has(id)) {
                next.add(id);
                changed = true;
            }
        }
        if (changed) this.ids = next;
    }

    /**
     * Consume one id (FolderItem, after expanding).
     * @returns true if the id was in the set
     */
    consume(id: string): boolean {
        if (!this.ids.has(id)) return false;
        const next = new Set(this.ids);
        next.delete(id);
        this.ids = next;
        return true;
    }

    /**
     * One id, or a clear — compatibility with the older call sites.
     * `set(null)` empties the queue; `set(id)` is `request([id])`.
     */
    set(value: string | null): void {
        if (value === null) {
            if (this.ids.size > 0) this.ids = new Set();
            return;
        }
        this.request([value]);
    }

    /** Test-only reset. */
    clear(): void {
        this.ids = new Set();
    }
}

export const pendingExpandId = new PendingExpandStore();
