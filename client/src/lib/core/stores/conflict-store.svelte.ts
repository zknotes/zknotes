/**
 * Conflict store — holds the recent conflict-copy entries the sync engine creates (a push 409, or a
 * concurrent change arriving on pull). A decoupling layer: the engine (core/sync) only adds an entry
 * here, and the layout reactively shows a toast with an "Open" action. That way the engine does not
 * depend on toasts or navigation (a core→modules import is forbidden, and `goto` stays in the
 * layout).
 *
 * This store is a DATA source only (the list). The "has this toast been shown already" dedup lives in
 * the layout (`notifiedConflictIds`) — one place of truth for presentation. The ids are uuidv7, so the
 * same conflict is never added twice.
 */

import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import { getDB } from "$lib/core/db";
import { normalizeConflictAt } from "$lib/core/utils/conflict-at";

export interface ConflictEntry {
    id: string;
    title: string; // the conflict copy's title (with the "[Conflict …]" prefix)
    type: "note" | "folder" | "file";
    /** Unix seconds — the only unit this store allows. */
    at: number;
    conflict_of?: string; // the id of the original document
}

const MAX_RECENT = 20;

class ConflictStore {
    recent = $state<ConflictEntry[]>([]);
    allConflicts = $state<ConflictEntry[]>([]);

    /** Adds an entry to the top of the list (for the toasts) and refreshes the full list. */
    add(e: ConflictEntry) {
        const entry = { ...e, at: normalizeConflictAt(e.at) };
        this.recent = [entry, ...this.recent].slice(0, MAX_RECENT);
        void this.loadAllConflicts();
    }

    /** Fetches every currently unresolved conflict out of IDB. */
    async loadAllConflicts() {
        if (typeof indexedDB === "undefined") return;
        const db = await getDB();
        const items = await db.getAll("items");

        const list: ConflictEntry[] = [];
        for (const item of items) {
            if (item.conflict_of) {
                try {
                    const payload = await decryptItemPayload<Record<string, unknown>>(item);
                    list.push({
                        id: item.id,
                        title: (payload.name || payload.title || "Untitled") as string,
                        type: item.type,
                        at: normalizeConflictAt(item.updated_at ?? Math.floor(Date.now() / 1000)),
                        conflict_of: item.conflict_of,
                    });
                } catch {
                    // ignore failed decryptions (a wrong key, say)
                }
            }
        }

        // Sort by time, descending (the newest first)
        list.sort((a, b) => b.at - a.at);
        this.allConflicts = list;
    }

    /** Removes a conflict from the UI list after it has been resolved. */
    removeResolved(id: string) {
        this.allConflicts = this.allConflicts.filter((c) => c.id !== id);
    }

    /** A reset on lock/logout (alongside teardownSession) — it empties the list. */
    clear() {
        this.recent = [];
        this.allConflicts = [];
    }
}

export const conflictStore = new ConflictStore();
