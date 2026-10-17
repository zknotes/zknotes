/**
 * The vault's UI keys that the pendingClear wipe misses and that restore phase 5 already clears.
 * One place in core — both `pullAndMerge` (a user switch) and the restore wizard call it.
 *
 * The `f_*` expand keys are cleared through `expandedFolders.clearAll` (the only place that handles
 * that prefix — do not go poking at localStorage here).
 */
import { pinManager } from "$lib/core/files/pin-manager-state.svelte";
import { recentNotesStore } from "$lib/core/stores/recent-notes.svelte";
import { expandedFolders } from "./expanded-folders";
import { STORAGE_KEYS } from "./persisted";

export function clearRestoreUiKeys(): void {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.removeItem(STORAGE_KEYS.recentNotes);
        localStorage.removeItem(STORAGE_KEYS.pinnedItems);
        expandedFolders.clearAll();
    } catch {
        // best-effort
    }
    try {
        recentNotesStore.ids = [];
    } catch {
        // the store may not be initialised (a test)
    }
    try {
        pinManager.roots = [];
    } catch {
        // the same
    }
}
