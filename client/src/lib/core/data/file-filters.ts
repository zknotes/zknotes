import type { DecryptedItemMeta } from "./items";

export type FileTypeFilter = "all" | "images" | "docs" | "audio" | "video";

export type ParsedScope =
    | { kind: "all" }
    | { kind: "note"; id: string }
    | { kind: "folder"; id: string };

export function parseScopeParam(raw: string | null): ParsedScope {
    if (!raw) return { kind: "all" };
    if (raw.startsWith("note:")) return { kind: "note", id: raw.slice("note:".length) };
    if (raw.startsWith("folder:")) return { kind: "folder", id: raw.slice("folder:".length) };
    return { kind: "all" };
}

export function scopeToParam(scope: ParsedScope): string | null {
    if (scope.kind === "all") return null;
    return scope.kind === "note" ? `note:${scope.id}` : `folder:${scope.id}`;
}

export function parseTypeParam(raw: string | null): FileTypeFilter {
    if (raw === "images" || raw === "docs" || raw === "audio" || raw === "video") return raw;
    return "all";
}

export function typeToParam(type: FileTypeFilter): string | null {
    return type === "all" ? null : type;
}

/** The MIME filter for the type chips. */
export function matchesFileType(mime: string | undefined, filter: FileTypeFilter): boolean {
    if (filter === "all") return true;
    const m = mime ?? "";
    if (filter === "images") return m.startsWith("image/");
    if (filter === "audio") return m.startsWith("audio/");
    if (filter === "video") return m.startsWith("video/");
    if (filter === "docs") {
        return (
            m.startsWith("text/") ||
            m.startsWith("application/pdf") ||
            m.includes("document") ||
            m.includes("word") ||
            m.includes("sheet") ||
            m.includes("presentation") ||
            m === "application/json" ||
            m === "application/octet-stream" ||
            m === "application/zip"
        );
    }
    return true;
}

type TreeItem = { id: string; type: string; parent_id: string | null };

/** Every READY note id in a folder and its subfolders. */
export function collectNoteIdsInFolder(folderId: string, items: TreeItem[]): Set<string> {
    const byParent = new Map<string | null, TreeItem[]>();
    for (const i of items) {
        if (i.type !== "note" && i.type !== "folder") continue;
        const list = byParent.get(i.parent_id) ?? [];
        list.push(i);
        byParent.set(i.parent_id, list);
    }

    const noteIds = new Set<string>();
    const queue = [...(byParent.get(folderId) ?? [])];
    const seen = new Set<string>();

    while (queue.length > 0) {
        const cur = queue.shift()!;
        if (seen.has(cur.id)) continue;
        seen.add(cur.id);
        if (cur.type === "note") noteIds.add(cur.id);
        else queue.push(...(byParent.get(cur.id) ?? []));
    }
    return noteIds;
}

export function filterFilesByScope(
    files: DecryptedItemMeta[],
    scope: ParsedScope,
    allItems: DecryptedItemMeta[],
): DecryptedItemMeta[] {
    if (scope.kind === "all") return files;
    if (scope.kind === "note") return files.filter((f) => f.parent_id === scope.id);
    const noteIds = collectNoteIdsInFolder(scope.id, allItems);
    return files.filter((f) => f.parent_id != null && noteIds.has(f.parent_id));
}

export function scopeLabel(scope: ParsedScope, items: DecryptedItemMeta[]): string {
    if (scope.kind === "all") return "All notes";
    const hit = items.find((i) => i.id === scope.id);
    if (scope.kind === "note") return hit?.title ?? "Note";
    return hit?.title ?? "Folder";
}

export type FileSort =
    | "updated_desc"
    | "updated_asc"
    | "size_desc"
    | "size_asc"
    | "name_asc"
    | "type_asc";

/**
 * The Files page order. A missing size counts as 0; "by type" groups on the mime and then by title;
 * names compare locale-aware. Returns a new array — the caller's list is left as it is.
 */
export function sortFiles<
    T extends { title: string; updated_at: number; size?: number; mime?: string },
>(files: readonly T[], sortBy: FileSort): T[] {
    return [...files].sort((a, b) => {
        switch (sortBy) {
            case "updated_asc":
                return a.updated_at - b.updated_at;
            case "size_desc":
                return (b.size || 0) - (a.size || 0);
            case "size_asc":
                return (a.size || 0) - (b.size || 0);
            case "name_asc":
                return a.title.localeCompare(b.title);
            case "type_asc": {
                const typeA = a.mime || "";
                const typeB = b.mime || "";
                return typeA !== typeB
                    ? typeA.localeCompare(typeB)
                    : a.title.localeCompare(b.title);
            }
            default:
                return b.updated_at - a.updated_at;
        }
    });
}
