/**
 * The id of the item waiting for rename mode (runes — formerly a writable).
 * Set after a new note or folder is created.
 * FolderItem consumes it and goes straight into rename mode.
 */
class PendingRenameStore {
    current = $state<string | null>(null);

    set(value: string | null) {
        this.current = value;
    }
}

export const pendingRenameId = new PendingRenameStore();
