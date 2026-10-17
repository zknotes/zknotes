/**
 * The expand state of the folders in the tree — the ONLY place that handles the localStorage
 * "f_<folderId>" keys (they used to be written from FolderItem, SearchDialog and the layout).
 *
 * The format is inherited and has to stay identical: the key is "f_" + id, the value is "1" while the
 * folder is expanded, and the key is deleted when it collapses. It is not a reactive store —
 * FolderItem holds its own $state, initialised through isExpanded().
 */

const PREFIX = "f_";

export const expandedFolders = {
    isExpanded(id: string): boolean {
        if (typeof localStorage === "undefined") return false;
        try {
            return localStorage.getItem(PREFIX + id) === "1";
        } catch {
            return false;
        }
    },

    expand(id: string): void {
        if (typeof localStorage === "undefined") return;
        try {
            localStorage.setItem(PREFIX + id, "1");
        } catch {
            // best-effort
        }
    },

    collapse(id: string): void {
        if (typeof localStorage === "undefined") return;
        try {
            localStorage.removeItem(PREFIX + id);
        } catch {
            // best-effort
        }
    },

    set(id: string, expanded: boolean): void {
        if (expanded) this.expand(id);
        else this.collapse(id);
    },

    /** A user switch / restore phase 5 — delete every expand state (not the theme or the zoom). */
    clearAll(): void {
        if (typeof localStorage === "undefined") return;
        try {
            const extra: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key?.startsWith(PREFIX)) extra.push(key);
            }
            for (const key of extra) localStorage.removeItem(key);
        } catch {
            // best-effort
        }
    },
};
