import { untrack } from "svelte";
import { loadPersisted, STORAGE_KEYS, savePersisted } from "$lib/core/utils/persisted";

const MAX_RECENT = 30;

const loadFromStorage = () => loadPersisted<string[]>(STORAGE_KEYS.recentNotes, []);
const saveToStorage = (ids: string[]) => savePersisted(STORAGE_KEYS.recentNotes, ids);

class RecentNotesStore {
    ids = $state<string[]>([]);

    init() {
        this.ids = loadFromStorage();
    }

    push(id: string) {
        // untrack, so no reactive dependency on the ids is created inside an $effect
        const current = untrack(() => this.ids);
        const next = [id, ...current.filter((x) => x !== id)].slice(0, MAX_RECENT);
        this.ids = next;
        saveToStorage(next);
    }

    remove(id: string) {
        const current = untrack(() => this.ids);
        const next = current.filter((x) => x !== id);
        this.ids = next;
        saveToStorage(next);
    }
}

export const recentNotesStore = new RecentNotesStore();
