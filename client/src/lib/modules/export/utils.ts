import { getDB, type LocalItem } from "$lib/core/db";

export async function loadLiveItems(): Promise<LocalItem[]> {
    const db = await getDB();
    const allItems = await db.getAll("items");
    return allItems.filter((i) => !i.deleted_at);
}

/**
 * Sanitises a string for use as a filesystem path component. `.` and `..` are replaced too: as a
 * ZIP path segment, a folder named `..` would climb out of the archive.
 */
export function safeName(name: string): string {
    const cleaned =
        name
            .replace(/[/\\:*?"<>|]/g, "_")
            .replace(/\s+/g, " ")
            .trim() || "Untitled";
    return cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

/** The metadata needed to reconstruct the ancestor path (folder-mirror). */
export interface PathMeta {
    parent_id: string | null;
    title: string;
    type: string;
}

/**
 * Builds the `<folder-path>` prefix for an item, without the item's own name, by climbing through its
 * ancestor folders. Items at the root — or whose parent is not a folder — get an empty prefix.
 * Cycle-safe.
 */
export function buildItemPath(itemId: string, byId: Map<string, PathMeta>): string {
    const parts: string[] = [];
    const visited = new Set<string>();
    let parentId = byId.get(itemId)?.parent_id ?? null;
    while (parentId) {
        if (visited.has(parentId)) break;
        visited.add(parentId);
        const p = byId.get(parentId);
        if (p?.type !== "folder") break;
        parts.unshift(safeName(p.title));
        parentId = p.parent_id;
    }
    return parts.join("/");
}

/** The minimal progress message every export shares (a phase plus a counter). */
export interface ExportTick {
    phase: string;
    done: number;
    total: number;
}

/** An item an export could not include, with the error that stopped it. */
export interface SkippedItem {
    id: string;
    type: string;
    reason: string;
}

/** What an export reports back: an empty `skipped` means everything was included. */
export interface ExportResult {
    skipped: SkippedItem[];
}

/**
 * A Template Method for a multi-phase export: it fixes the skeleton "emit progress → per item,
 * decrypt and serialise (an error = a warning plus a skip) → done++ → emit", while the caller varies
 * only the grouping, the serialisation and the finalisation. A shared `done` counter runs through
 * every phase.
 *
 * The generic `P` is the export's concrete progress type (ExportProgress / FullBackupProgress, say),
 * so `phase` stays typed to its union of values.
 */
export class ExportRun<P extends ExportTick> {
    done = 0;
    /** Every item a phase gave up on — reported to the user instead of vanishing into the console. */
    readonly skipped: SkippedItem[] = [];

    constructor(
        readonly total: number,
        private readonly onProgress?: (p: P) => void,
    ) {}

    /** Emit the current progress under the given phase. */
    emit(phase: P["phase"]): void {
        this.onProgress?.({ phase, done: this.done, total: this.total } as P);
    }

    /**
     * Records an item the export cannot include. `warnLabel` plus `item.type`/`item.id` form the
     * console message; the item also lands in `skipped`, which the export returns.
     */
    skip(item: { id: string; type: string }, error: unknown, warnLabel: string): void {
        console.warn(`${warnLabel}: skipping ${item.type} ${item.id}`, error);
        this.skipped.push({
            id: item.id,
            type: item.type,
            reason: error instanceof Error ? error.message : String(error),
        });
    }

    /**
     * Runs one phase: emit(phase) at the start, then `handle` per item (an error → `skip`), with
     * `done++` and an emit after each.
     */
    async stage<T extends { id: string; type: string }>(
        phase: P["phase"],
        items: readonly T[],
        warnLabel: string,
        handle: (item: T) => Promise<void>,
    ): Promise<void> {
        this.emit(phase);
        for (const item of items) {
            try {
                await handle(item);
            } catch (e) {
                this.skip(item, e, warnLabel);
            }
            this.done++;
            this.emit(phase);
        }
    }
}

/**
 * A ZIP entry name nobody has used yet: `base + ext`, else `base (2) + ext`, `(3)`… Two notes of the
 * same name in one folder would otherwise be two entries of one name, and an unzip keeps only one.
 * Records the result in `used`.
 */
export function uniquePath(base: string, ext: string, used: Set<string>): string {
    let path = `${base}${ext}`;
    for (let n = 2; used.has(path); n++) path = `${base} (${n})${ext}`;
    used.add(path);
    return path;
}
