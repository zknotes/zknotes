// The TanStack Query keys — the one definition (they used to be string literals across 15+ files).
export const QUERY_KEYS = {
    /** The whole tree of decrypted metadata (getTreeItems). */
    treeItems: ["tree-items"] as const,
    /** The deleted items, for the trash view (getDeletedItems). */
    deletedItems: ["deleted-items"] as const,
    /** A single note (the decrypted payload). */
    note: (id: string) => ["note", id] as const,
};
