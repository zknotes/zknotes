/**
 * The v2 backup item shapes and the small builder the content module writes against.
 *
 * These interfaces mirror `BackupItem` in `client/src/lib/modules/export/full-backup.ts`. `scripts/`
 * sits outside the workspaces, so the real types cannot be imported here — if that file's contract
 * changes, this one has to follow (`scripts/make-demo-vault.test.ts` checks the parts it can).
 */

import { createHash } from "node:crypto";

export interface BackupNote {
    id: string;
    type: "note";
    parent_id: string | null;
    sort_order: string;
    title: string;
    content: string;
    color?: string;
    icon?: string;
    starred?: boolean;
    created_at: number;
    updated_at: number;
    version: number;
}

export interface BackupFolder {
    id: string;
    type: "folder";
    parent_id: string | null;
    sort_order: string;
    title: string;
    color?: string;
    icon?: string;
    starred?: boolean;
    created_at: number;
    updated_at: number;
    version: number;
}

export interface BackupFile {
    id: string;
    type: "file";
    parent_id: string | null;
    sort_order: string;
    name: string;
    mime: string;
    size: number;
    description?: string;
    created_at: number;
    updated_at: number;
    version: number;
}

export type BackupItem = BackupNote | BackupFolder | BackupFile;

/**
 * A UUIDv7-shaped id derived from (seed, slug).
 *
 * Deterministic within one seed, so the ids are stable across a regeneration: a note's
 * `data-file-id` keeps pointing at its attachment, and importing the same file twice in
 * `skip_existing` mode is a no-op rather than a duplicate tree.
 *
 * The seed has to vary between generated files, though — an item id is a GLOBAL primary key on the
 * server, so two accounts on one instance cannot hold the same ids, and the second import is
 * rejected with a version drift.
 */
export function demoId(slug: string, seed: string): string {
    const digest = createHash("sha256").update(`zknotes-demo-vault/${seed}/${slug}`).digest();
    const bytes = Uint8Array.from(digest.subarray(0, 16));
    bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70; // version 7
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Seconds since the epoch — the unit `items.created_at` / `items.updated_at` use. */
export function at(year: number, month: number, day: number, hour = 9, minute = 0): number {
    return Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 1000);
}

export interface Timestamps {
    created: number;
    updated?: number;
}

export interface DemoVault {
    items: BackupItem[];
    files: Map<string, Uint8Array>;
}

/** Collects the tree and hands out lexicographically ordered sort keys per parent. */
export class VaultBuilder {
    readonly items: BackupItem[] = [];
    readonly files = new Map<string, Uint8Array>();
    readonly #nextOrder = new Map<string, number>();
    readonly #seed: string;

    constructor(seed: string) {
        this.#seed = seed;
    }

    /** The id this builder would give that slug — for a reference written before the item exists. */
    id(slug: string): string {
        return demoId(slug, this.#seed);
    }

    #order(parentId: string | null): string {
        const key = parentId ?? "__root__";
        const next = this.#nextOrder.get(key) ?? 0;
        this.#nextOrder.set(key, next + 1);
        // sort_order is compared as a string, never parsed — a fixed width keeps "a10" after "a09".
        return `a${String(next).padStart(3, "0")}`;
    }

    folder(
        slug: string,
        parentId: string | null,
        title: string,
        time: Timestamps,
        extra: { color?: string; icon?: string; starred?: boolean } = {},
    ): string {
        const id = this.id(slug);
        this.items.push({
            id,
            type: "folder",
            parent_id: parentId,
            sort_order: this.#order(parentId),
            title,
            created_at: time.created,
            updated_at: time.updated ?? time.created,
            version: 1,
            ...extra,
        });
        return id;
    }

    note(
        slug: string,
        parentId: string | null,
        title: string,
        content: string,
        time: Timestamps,
        extra: { color?: string; icon?: string; starred?: boolean } = {},
    ): string {
        const id = this.id(slug);
        this.items.push({
            id,
            type: "note",
            parent_id: parentId,
            sort_order: this.#order(parentId),
            title,
            content,
            created_at: time.created,
            updated_at: time.updated ?? time.created,
            version: 1,
            ...extra,
        });
        return id;
    }

    file(
        slug: string,
        parentId: string | null,
        name: string,
        mime: string,
        bytes: Uint8Array,
        time: Timestamps,
        description?: string,
    ): string {
        const id = this.id(slug);
        this.items.push({
            id,
            type: "file",
            parent_id: parentId,
            sort_order: this.#order(parentId),
            name,
            mime,
            size: bytes.byteLength,
            created_at: time.created,
            updated_at: time.updated ?? time.created,
            version: 1,
            ...(description ? { description } : {}),
        });
        this.files.set(id, bytes);
        return id;
    }
}
