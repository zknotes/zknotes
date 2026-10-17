/**
 * Iteratively checks if updating `targetId`'s parent to `newParentId`
 * creates a cycle in the folder hierarchy.
 *
 * @param targetId The ID of the item being moved
 * @param newParentId The proposed new parent ID
 * @param parentMap A function or map to look up an item's parent_id.
 *        If using a Map, the key is the item ID and value is parent ID.
 * @returns true if a cycle is detected, false otherwise.
 */
export function createsCycle(
    targetId: string,
    newParentId: string | null,
    parentMap: Map<string, string | null> | ((id: string) => string | null),
): boolean {
    if (newParentId === null) {
        return false;
    }

    // A folder cannot be its own parent
    if (targetId === newParentId) {
        return true;
    }

    const isFn = typeof parentMap === "function";
    const getParent = isFn
        ? parentMap
        : (id: string) => (parentMap.has(id) ? (parentMap.get(id) ?? null) : null);

    const visited = new Set<string>();
    let currentId: string | null = newParentId;
    let depth = 0;
    // The depth guard is SEPARATE from cycle detection and applies ONLY to a function-based
    // source (a lazy source gives no guarantee of finiteness → runaway protection). For a Map the
    // node set is finite, so `visited` alone guarantees both termination and exact cycle detection —
    // with no false positive on a deeply, but validly, nested tree more than ~1000 levels down.
    const maxDepth = isFn ? 1000 : Number.POSITIVE_INFINITY;

    while (currentId !== null) {
        if (currentId === targetId) {
            // The target folder was reached along the parent chain → a cycle!
            return true;
        }

        if (visited.has(currentId)) {
            // An existing cycle in the data
            return true;
        }

        visited.add(currentId);
        depth++;

        if (depth > maxDepth) {
            // Runaway function-based source — a best-effort bail-out, not a claim of a cycle on Map input.
            return true;
        }

        currentId = getParent(currentId);
    }

    return false;
}

/**
 * Topological sort by `parent_id` — a parent always precedes its child when BOTH are in the same
 * set. Items whose parent is not in the set keep their relative order. The stack guard prevents
 * infinite recursion on a cycle (the actual cycle rejection is the `createsCycle` pre-flight).
 *
 * Server and client share it, and they are TWO different defences against the same error
 * ("Parent not found"):
 * - the server (`POST /items/batch`) sorts the upsert within ONE batch,
 * - the client (sync engine) sorts the mutation queue before chunking, so that a child does not
 *   land in an earlier chunk than its parent (that is how bulk restore silently moved notes
 *   to the root).
 *
 * `parentOf` is explicit because the client sorts mutations that do not carry `parent_id`
 * themselves (it reads it from IndexedDB), while the server sorts wire items that do.
 */
export function topoSortByParent<T extends { id: string }>(
    batch: T[],
    parentOf: (item: T) => string | null,
): T[] {
    const byId = new Map(batch.map((i) => [i.id, i]));
    const visited = new Set<string>();
    const result: T[] = [];

    // Iterative DFS — a recursive `visit` blows the call stack on a chain 100k deep.
    // Same semantics: parent before child; a cycle breaks out without throwing
    // (the actual cycle rejection is the `createsCycle` pre-flight).
    for (const start of batch) {
        if (visited.has(start.id)) continue;

        const stack: T[] = [start];
        const path = new Set<string>();

        while (stack.length > 0) {
            const item = stack[stack.length - 1]!;
            if (visited.has(item.id)) {
                stack.pop();
                continue;
            }
            if (!path.has(item.id)) {
                path.add(item.id);
                const parentId = parentOf(item);
                const parent = parentId ? byId.get(parentId) : undefined;
                if (parent && !visited.has(parent.id) && !path.has(parent.id)) {
                    stack.push(parent);
                    continue;
                }
            }
            path.delete(item.id);
            stack.pop();
            visited.add(item.id);
            result.push(item);
        }
    }
    return result;
}
