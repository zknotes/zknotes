export type FlatItem = {
    id: string;
    parent_id: string | null;
    sort_order: string;
    type: string;
    title?: string;
};

export type TreeNode = FlatItem & { children: TreeNode[] };

/**
 * True when walking `parent_id` from `id` returns to `id`. Used so a folder cycle still appears
 * as roots instead of vanishing from the sidebar (both nodes would otherwise only exist as each
 * other's children and never be pushed onto `roots`).
 */
function parentChainLoopsThrough(id: string, map: Map<string, TreeNode>): boolean {
    const seen = new Set<string>();
    let cur: string | null | undefined = map.get(id)?.parent_id;
    while (cur && map.has(cur)) {
        if (cur === id) return true;
        if (seen.has(cur)) return false;
        seen.add(cur);
        cur = map.get(cur)?.parent_id;
    }
    return false;
}

// Memoizes the single caller (FolderTree.svelte's `$derived`) against a refetch that returns
// content-identical data (query "perf 10") — TanStack Query can hand back a new array reference
// with the same content, which would otherwise rebuild every TreeNode and cascade a re-render
// through every mounted FolderItem. Keyed on a full JSON fingerprint (not just id/parent_id/
// sort_order) because buildTree spreads every field of `item` onto its TreeNode, and a stale node
// would silently hide a title/color/icon/starred change that didn't also touch that narrower key.
let lastItems: FlatItem[] | null = null;
let lastFingerprint: string | null = null;
let lastFilterFiles: boolean | null = null;
let lastResult: TreeNode[] | null = null;

/** Sorts a flat list and builds the hierarchical tree. Filters out the "file" type by default. */
export function buildTree(items: FlatItem[], filterFiles = true): TreeNode[] {
    if (items === lastItems && filterFiles === lastFilterFiles && lastResult !== null) {
        return lastResult;
    }
    const fingerprint = JSON.stringify(items);
    if (lastResult !== null && fingerprint === lastFingerprint && filterFiles === lastFilterFiles) {
        lastItems = items;
        return lastResult;
    }

    const rawItems = filterFiles ? items.filter((i) => i.type !== "file") : items;
    const sortedItems = [...rawItems].sort((a, b) =>
        a.sort_order < b.sort_order ? -1 : a.sort_order > b.sort_order ? 1 : 0,
    );

    const map = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];

    for (const item of sortedItems) {
        map.set(item.id, { ...item, children: [] });
    }

    for (const item of sortedItems) {
        const node = map.get(item.id);
        if (!node) continue;
        if (item.parent_id && map.has(item.parent_id) && !parentChainLoopsThrough(item.id, map)) {
            map.get(item.parent_id)?.children.push(node);
        } else {
            roots.push(node);
        }
    }

    lastItems = items;
    lastFingerprint = fingerprint;
    lastFilterFiles = filterFiles;
    lastResult = roots;
    return roots;
}

export interface BreadcrumbSegment {
    id: string;
    title: string;
    color?: string;
    icon?: string;
    type?: string;
}

/** Builds the breadcrumb trail from the root to the given id (the node itself included). Cycle-safe. */
export function buildBreadcrumb(id: string, items: FlatItem[]): BreadcrumbSegment[] {
    const byId = new Map(items.map((it) => [it.id, it]));
    const trail: BreadcrumbSegment[] = [];
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        trail.unshift({
            id: cur.id,
            title: cur.title || "Untitled",
            color: (cur as any).color,
            icon: (cur as any).icon,
            type: cur.type,
        });
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return trail;
}

/**
 * Is `childId` a descendant of `ancestorId` (climbing the parent_id chain)? Cycle-safe.
 * Used, for instance, to redirect the open note when an ancestor folder of it is deleted.
 */
export function isDescendantOf(
    childId: string,
    ancestorId: string,
    items: readonly { id: string; parent_id: string | null }[],
): boolean {
    const byId = new Map(items.map((it) => [it.id, it]));
    const seen = new Set<string>();
    let cur = byId.get(childId);
    while (cur?.parent_id && !seen.has(cur.parent_id)) {
        if (cur.parent_id === ancestorId) return true;
        seen.add(cur.parent_id);
        cur = byId.get(cur.parent_id);
    }
    return false;
}

/**
 * Walks the parent_id chain up from `id` `levels` times (for drag-outdent — it turns "how many
 * levels to the left" into a real ancestor). Stops at the root if the tree is shallower than
 * `levels`.
 */
export function getAncestor<T extends { id: string; parent_id: string | null }>(
    id: string,
    levels: number,
    items: readonly T[],
): T | undefined {
    const byId = new Map(items.map((it) => [it.id, it]));
    let cur = byId.get(id);
    for (let i = 0; i < levels && cur?.parent_id; i++) {
        cur = byId.get(cur.parent_id);
    }
    return cur;
}

/**
 * Collects `seeds` + all of their descendants (a fixpoint traversal over the flat list). The
 * `include` predicate filters which descendants to take — only the trashed ones
 * (`(it) => !!it.deleted_at`) for restore/permanent-delete, say, or all of them (the default) for a
 * cascade delete. Cycle-safe (the Set prevents a second visit). One definition of the traversal
 * instead of the `while (added)` loop repeated by hand
 * (deleteItem/restoreItem/permanentDeleteItem).
 */
export function collectDescendants<T extends { id: string; parent_id: string | null }>(
    items: readonly T[],
    seeds: Iterable<string>,
    include: (item: T) => boolean = () => true,
): Set<string> {
    const result = new Set<string>(seeds);
    let added = true;
    while (added) {
        added = false;
        for (const it of items) {
            if (it.parent_id && result.has(it.parent_id) && !result.has(it.id) && include(it)) {
                result.add(it.id);
                added = true;
            }
        }
    }
    return result;
}

/**
 * The chain from `id` towards the root (`id` included, the root last). Cycle-safe.
 * For a reveal in the tree: expand every ancestor so the new child becomes visible.
 */
export function collectAncestorIds(
    id: string,
    items: readonly { id: string; parent_id: string | null }[],
): string[] {
    const byId = new Map(items.map((it) => [it.id, it]));
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        chain.push(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
}

/** Builds a slash-separated path from the PARENT titles ONLY (excluding the node itself). Cycle-safe. */
export function buildParentPath(id: string, items: FlatItem[]): string {
    return buildParentPathFrom(id, new Map(items.map((it) => [it.id, it])));
}

/**
 * buildParentPath against an already indexed map — the palette renders several rows per keystroke
 * and must not rebuild the index of the whole vault for each of them.
 */
export function buildParentPathFrom(id: string, byId: ReadonlyMap<string, FlatItem>): string {
    const trail: string[] = [];
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur?.parent_id && !seen.has(cur.parent_id)) {
        seen.add(cur.parent_id);
        const parent = byId.get(cur.parent_id);
        if (parent) trail.unshift(parent.title || "Untitled");
        cur = parent;
    }
    return trail.join(" / ");
}
