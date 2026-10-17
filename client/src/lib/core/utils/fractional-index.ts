// Fractional indexing for sort_order strings — the former order.ts and sort-order.ts merged.

export function getMidString(prev: string | null, next: string | null): string {
    if (!prev && !next) return Date.now().toString(36);
    if (!prev && next) return `0${next}`; // prepending '0' makes it smaller
    if (prev && !next) return `${prev}z`; // appending 'z' makes it larger
    if (!prev || !next) throw new Error("unreachable");

    const p = prev;
    const n = next;

    // Find the first differing character
    let i = 0;
    while (i < p.length && i < n.length && p.charAt(i) === n.charAt(i)) {
        i++;
    }

    // Turn the character into a strict ASCII code
    // If a string has ended, its "next" character is treated as 0, the smallest possible
    const pChar = i < p.length ? p.charCodeAt(i) : 0;
    const nChar = i < n.length ? n.charCodeAt(i) : 127;

    // We need a character strictly > pChar and < nChar
    if (nChar - pChar > 1) {
        let mid = Math.floor((pChar + nChar) / 2);
        // Avoid non-printable ASCII where possible, even though it works in memory.
        // Better: when pChar is 0, use something like pChar + 1
        if (pChar === 0) mid = Math.max(33, Math.floor(nChar / 2));
        return p.substring(0, i) + String.fromCharCode(mid);
    } else {
        // nChar and pChar are adjacent.
        // No character fits between them at this position.
        // We have to extend p so it is slightly larger.
        // A character from the exact middle of the ASCII range is appended.
        // e.g. "U" (85)
        return `${p}U`;
    }
}

type SortableItem = {
    id: string;
    parent_id: string | null;
    sort_order: string;
    type: string;
};

function sortByOrder<T extends { sort_order: string }>(items: T[]): T[] {
    return [...items].sort((a, b) =>
        a.sort_order < b.sort_order ? -1 : a.sort_order > b.sort_order ? 1 : 0,
    );
}

/**
 * Computes { parentId, sortOrder } for a new item created relative to a reference item.
 * - If the reference is a folder: the new item goes in as its first child (a prepend).
 * - If the reference is a note: the new item goes immediately after it, between that note and its current successor
 *   (getMidString) — NOT by appending a timestamp (see the note below).
 * - If no refItem is passed: it returns null/undefined (the item goes to the root with no defined order).
 *
 * The former `${sort_order}a${Date.now()}` pattern grew by ~14 characters PER CALL. After each
 * create, the UI (the "New note" action, say) sets the note just created as the next reference, so
 * successive clicks recursively lengthen the same string until it breaks Zod's `sort_order.max(256)`
 * and the server refuses the whole push batch.
 */
export function calcInsertSortOrder(
    refItem: SortableItem | undefined,
    allItems: SortableItem[],
): { parentId: string | null; sortOrder: string | undefined } {
    if (!refItem) return { parentId: null, sortOrder: undefined };

    if (refItem.type === "folder") {
        const children = sortByOrder(allItems.filter((i) => i.parent_id === refItem.id));
        return {
            parentId: refItem.id,
            sortOrder: children.length > 0 ? `0${children[0].sort_order}` : undefined,
        };
    }

    const siblings = sortByOrder(allItems.filter((i) => i.parent_id === refItem.parent_id));
    const refIndex = siblings.findIndex((i) => i.id === refItem.id);
    const next =
        refIndex >= 0 && refIndex < siblings.length - 1
            ? (siblings[refIndex + 1]?.sort_order ?? null)
            : null;
    return {
        parentId: refItem.parent_id,
        sortOrder: getMidString(refItem.sort_order, next),
    };
}

/**
 * Computes { newParentId, newSortOrder } for a drag-and-drop drop operation.
 * pos "inside": the item becomes the first child of the targetNode folder.
 * pos "top"/"bottom": the item becomes a sibling of targetNode, above or below it.
 */
export function calcDropSortOrder(
    pos: "top" | "bottom" | "inside",
    targetNode: SortableItem,
    allItems: SortableItem[],
): { newParentId: string | null; newSortOrder: string } {
    if (pos === "inside" && targetNode.type === "folder") {
        const children = sortByOrder(allItems.filter((i) => i.parent_id === targetNode.id));
        return {
            newParentId: targetNode.id,
            newSortOrder:
                children.length > 0 ? `0${children[0].sort_order}` : Date.now().toString(36),
        };
    }

    const siblings = sortByOrder(allItems.filter((i) => i.parent_id === targetNode.parent_id));
    const nodeIndex = siblings.findIndex((i) => i.id === targetNode.id);

    if (pos === "top") {
        const prev = nodeIndex > 0 ? siblings[nodeIndex - 1]?.sort_order : null;
        return {
            newParentId: targetNode.parent_id,
            newSortOrder: getMidString(prev, targetNode.sort_order),
        };
    }

    // pos === "bottom" (below the target)
    const next = nodeIndex < siblings.length - 1 ? siblings[nodeIndex + 1]?.sort_order : null;
    return {
        newParentId: targetNode.parent_id,
        newSortOrder: getMidString(targetNode.sort_order, next),
    };
}
