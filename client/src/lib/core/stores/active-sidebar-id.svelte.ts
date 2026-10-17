/** The selected node in the sidebar tree (runes — formerly a writable). */
class ActiveSidebarIdStore {
    current = $state<string | null>(null);

    set(value: string | null) {
        this.current = value;
    }
}

export const activeSidebarId = new ActiveSidebarIdStore();
