// A consistent remapping of ids for a restore.
// It has to be done OVER the plaintext, before the encryption: parent_id and the encFile references.
import { restoreRemapId } from "@zknotes/shared";
import { uuidv7 } from "uuidv7";
import type { BackupItem, BackupNote } from "./full-backup";

export interface RemapResult {
    items: BackupItem[];
    fileMap: Map<string, Uint8Array>;
    /** old → new, for the ids that were really remapped only. */
    idMap: Map<string, string>;
}

function rewriteFileRefs(html: string, idMap: Map<string, string>): string {
    if (idMap.size === 0 || !html.includes("data-file-id")) return html;
    return html.replace(/data-file-id\s*=\s*(["'])([^"']+)\1/gi, (match, quote, id) => {
        const next = idMap.get(id);
        return next ? `data-file-id=${quote}${next}${quote}` : match;
    });
}

/**
 * Remaps the ids that exist on the server as a **purged** tombstone.
 * `generateId` is for the tests; production uses `backupHash` (deterministic), or `uuidv7` when no
 * hash is given.
 */
export function remapPurgedIds(
    items: BackupItem[],
    fileMap: Map<string, Uint8Array>,
    purgedIds: Iterable<string>,
    generateId?: (oldId: string) => string,
    backupHash?: string,
): RemapResult {
    const purged = new Set(purgedIds);
    const idMap = new Map<string, string>();
    for (const item of items) {
        if (!purged.has(item.id)) continue;
        const next = generateId
            ? generateId(item.id)
            : backupHash
              ? restoreRemapId(backupHash, item.id)
              : uuidv7();
        idMap.set(item.id, next);
    }

    const lookup = (id: string | null): string | null => {
        if (id == null) return null;
        return idMap.get(id) ?? id;
    };

    const remapped: BackupItem[] = items.map((item) => {
        const id = lookup(item.id) as string;
        const parent_id = lookup(item.parent_id);
        if (item.type === "note") {
            const note = item as BackupNote;
            return {
                ...note,
                id,
                parent_id,
                content: rewriteFileRefs(note.content ?? "", idMap),
            };
        }
        return { ...item, id, parent_id };
    });

    const nextFiles = new Map<string, Uint8Array>();
    for (const [oldId, bytes] of fileMap) {
        nextFiles.set(idMap.get(oldId) ?? oldId, bytes);
    }

    return { items: remapped, fileMap: nextFiles, idMap };
}
