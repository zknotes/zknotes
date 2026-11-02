// Fractional indexing for sort_order strings — the former order.ts and sort-order.ts merged.
//
// A sort_order is an opaque string compared with plain `<` (UTF-16 code units) — never a number.
// The digits are the printable ASCII range '!' (33) … '~' (126), and '!' is the "zero digit": a
// key generated here never ENDS in it, so between a key and any longer key sharing it as a prefix
// there is always room (the same convention as the trailing-zero rule of fractional-indexing).
// A key grows by one character only when its two neighbours are adjacent at every position; a
// prepend, an append or a midpoint otherwise keeps the length. Sibling lists whose keys have
// grown past SORT_ORDER_REBALANCE_LENGTH are reset to short, evenly spaced keys.

const MIN_DIGIT = 33; // '!'
const MAX_DIGIT = 126; // '~'
const BASE = MAX_DIGIT - MIN_DIGIT + 1; // 94 digits

/** A sibling list with a key longer than this gets rebalanced (see planSortOrderRebalance). */
export const SORT_ORDER_REBALANCE_LENGTH = 200;
/** The wire schema's cap on sort_order (shared/src/schemas.ts) — a key must stay below it. */
export const SORT_ORDER_MAX_LENGTH = 256;

/** The digit value of a code unit: below the range counts as "less than any digit", above as "more". */
function digitValue(code: number): number {
    if (code < MIN_DIGIT) return -1;
    if (code > MAX_DIGIT) return BASE;
    return code - MIN_DIGIT;
}

function digitChar(d: number): string {
    return String.fromCharCode(MIN_DIGIT + d);
}

/**
 * A key strictly between `a` and `b` (`b === null` means no upper bound; `a === ""` means no lower
 * bound). Precondition: `a < b`.
 */
function midpoint(a: string, b: string | null): string {
    let n = 0;
    if (b !== null) {
        // The common prefix. An exhausted `a` is padded with zero digits, so "" and "!x" share the
        // "!" — otherwise the fork would see two equal digits and nothing would fit between them.
        while (n < b.length && (n < a.length ? a.charCodeAt(n) : MIN_DIGIT) === b.charCodeAt(n)) {
            n++;
        }
    }
    const prefix = b === null ? "" : b.slice(0, n);
    const restA = a.slice(n);
    const restB = b === null ? null : b.slice(n);
    // The digit at the fork: an exhausted `a` counts as the zero digit; an exhausted `b` (b is a
    // proper prefix of a) would mean a > b and falls through to the fallback.
    const dA = restA.length > 0 ? digitValue(restA.charCodeAt(0)) : 0;
    const dB = restB === null ? BASE : restB.length > 0 ? digitValue(restB.charCodeAt(0)) : -1;

    if (dB - dA > 1) {
        return prefix + digitChar(Math.floor((dA + dB) / 2));
    }
    if (dB === dA + 1) {
        if (restB !== null && restB.length > 1) {
            // b carries more digits after the fork: keep b's digit and go below b's remainder.
            return prefix + restB.charAt(0) + midpoint("", restB.slice(1));
        }
        // Nothing fits at this position: keep a's digit and go deeper on a's side, unbounded above.
        const headA = restA.length > 0 ? restA.charAt(0) : digitChar(0);
        return prefix + headA + midpoint(restA.slice(1), null);
    }
    // a >= b at the fork: unordered inputs (equal keys exist — a conflict copy shares its
    // original's), or a legacy key that ends in the zero digit so nothing printable fits below it.
    // Keep the order where one exists rather than throw.
    return b === null ? a + digitChar(Math.floor(BASE / 2)) : `${prefix} `;
}

/**
 * A sort_order between two neighbours. `null` on either side means "no neighbour there": a
 * prepend (`getMidString(null, first)`), an append (`getMidString(last, null)`), or the first key
 * of an empty list. Equal or inverted neighbours (two items with the same key) place the result
 * right after `prev`.
 */
export function getMidString(prev: string | null, next: string | null): string {
    const a = prev ?? "";
    if (next !== null && a >= next) return midpoint(a, null);
    return midpoint(a, next);
}

/**
 * `count` short keys, evenly spaced over the whole key space and in ascending order — what a
 * rebalance assigns to a sibling list whose keys have grown too long.
 */
export function generateEvenSortOrders(count: number): string[] {
    if (count <= 0) return [];
    // Enough digits that `count + 1` slots fit with room between them.
    let length = 1;
    let space = BASE;
    while (space < 2 * (count + 1)) {
        length++;
        space *= BASE;
    }
    const step = Math.floor(space / (count + 1));
    const keys: string[] = [];
    for (let i = 1; i <= count; i++) {
        let value = step * i;
        let key = "";
        for (let d = 0; d < length; d++) {
            key = digitChar(value % BASE) + key;
            value = Math.floor(value / BASE);
        }
        // Trailing zero digits add nothing to the position and a key never ends in one.
        keys.push(key.replace(/!+$/, ""));
    }
    return keys;
}

/**
 * Whether a sibling list needs a rebalance, and the new keys if so: `null` when every key is still
 * short enough, otherwise the siblings whose key changes, in their current order, with the key to
 * assign. The caller (ItemService) writes and pushes them.
 */
export function planSortOrderRebalance<T extends { id: string; sort_order: string }>(
    siblings: readonly T[],
): Array<{ id: string; sort_order: string }> | null {
    if (!siblings.some((s) => s.sort_order.length > SORT_ORDER_REBALANCE_LENGTH)) return null;
    const ordered = sortByOrder([...siblings]);
    const keys = generateEvenSortOrders(ordered.length);
    const changes: Array<{ id: string; sort_order: string }> = [];
    for (let i = 0; i < ordered.length; i++) {
        const item = ordered[i];
        const key = keys[i];
        if (!item || key === undefined || item.sort_order === key) continue;
        changes.push({ id: item.id, sort_order: key });
    }
    return changes;
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
        const first = children[0];
        return {
            parentId: refItem.id,
            sortOrder: first ? getMidString(null, first.sort_order) : undefined,
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
        const first = children[0];
        return {
            newParentId: targetNode.id,
            newSortOrder: getMidString(null, first ? first.sort_order : null),
        };
    }

    const siblings = sortByOrder(allItems.filter((i) => i.parent_id === targetNode.parent_id));
    const nodeIndex = siblings.findIndex((i) => i.id === targetNode.id);

    if (pos === "top") {
        const prev = nodeIndex > 0 ? siblings[nodeIndex - 1]?.sort_order : null;
        return {
            newParentId: targetNode.parent_id,
            newSortOrder: getMidString(prev ?? null, targetNode.sort_order),
        };
    }

    // pos === "bottom" (below the target)
    const next = nodeIndex < siblings.length - 1 ? siblings[nodeIndex + 1]?.sort_order : null;
    return {
        newParentId: targetNode.parent_id,
        newSortOrder: getMidString(targetNode.sort_order, next ?? null),
    };
}
