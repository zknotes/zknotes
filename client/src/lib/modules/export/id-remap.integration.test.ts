import { describe, expect, it } from "vitest";
import { extractFileRefs } from "$lib/modules/files/refs";
import type { BackupFile, BackupFolder, BackupNote } from "./full-backup";
import { remapPurgedIds } from "./id-remap";

const FOLDER: BackupFolder = {
    id: "11111111-1111-7111-8111-111111111111",
    type: "folder",
    parent_id: null,
    sort_order: "a",
    title: "Parent",
    created_at: 1,
    updated_at: 1,
    version: 1,
};

const NOTE: BackupNote = {
    id: "22222222-2222-7222-8222-222222222222",
    type: "note",
    parent_id: FOLDER.id,
    sort_order: "b",
    title: "Child",
    content: `<p>see <img data-file-id="33333333-3333-7333-8333-333333333333" /></p>`,
    created_at: 2,
    updated_at: 2,
    version: 1,
};

const FILE: BackupFile = {
    id: "33333333-3333-7333-8333-333333333333",
    type: "file",
    parent_id: NOTE.id,
    sort_order: "c",
    name: "pic.png",
    mime: "image/png",
    size: 4,
    created_at: 3,
    updated_at: 3,
    version: 1,
};

const NESTED: BackupNote = {
    id: "44444444-4444-7444-8444-444444444444",
    type: "note",
    parent_id: NOTE.id,
    sort_order: "d",
    title: "Grandchild",
    content: "<p>plain</p>",
    created_at: 4,
    updated_at: 4,
    version: 1,
};

describe("remapPurgedIds", () => {
    it("rewrites nested parent_id and encFile refs before any encryption", () => {
        const fileBytes = new Uint8Array([1, 2, 3, 4]);
        const ids: Record<string, string> = {
            [FOLDER.id]: "aaaaaaa1-0000-7000-8000-000000000001",
            [FILE.id]: "aaaaaaa2-0000-7000-8000-000000000002",
        };
        const { items, fileMap, idMap } = remapPurgedIds(
            [NESTED, NOTE, FILE, FOLDER],
            new Map([[FILE.id, fileBytes]]),
            new Set([FOLDER.id, FILE.id]),
            (oldId) => ids[oldId]!,
        );

        expect(idMap.get(FOLDER.id)).toBe(ids[FOLDER.id]);
        expect(idMap.get(FILE.id)).toBe(ids[FILE.id]);
        expect(idMap.has(NOTE.id)).toBe(false);

        const folder = items.find((x) => x.id === ids[FOLDER.id]);
        const note = items.find((x) => x.id === NOTE.id) as BackupNote;
        const file = items.find((x) => x.id === ids[FILE.id]) as BackupFile;
        const nested = items.find((x) => x.id === NESTED.id) as BackupNote;

        expect(folder?.parent_id).toBeNull();
        expect(note.parent_id).toBe(ids[FOLDER.id]);
        expect(file.parent_id).toBe(NOTE.id);
        expect(nested.parent_id).toBe(NOTE.id);

        expect(extractFileRefs(note.content)).toEqual([ids[FILE.id]]);
        expect(fileMap.get(ids[FILE.id]!)).toEqual(fileBytes);
        expect(fileMap.has(FILE.id)).toBe(false);
    });

    it("is deterministic for the same backup_hash so resume restages the same new ids", () => {
        const a = remapPurgedIds([FOLDER], new Map(), [FOLDER.id], undefined, "hash-one");
        const b = remapPurgedIds([FOLDER], new Map(), [FOLDER.id], undefined, "hash-one");
        const c = remapPurgedIds([FOLDER], new Map(), [FOLDER.id], undefined, "hash-two");
        expect(a.idMap.get(FOLDER.id)).toBe(b.idMap.get(FOLDER.id));
        expect(a.idMap.get(FOLDER.id)).not.toBe(c.idMap.get(FOLDER.id));
    });

    it("leaves items untouched when nothing is purged", () => {
        const { items, idMap } = remapPurgedIds([FOLDER, NOTE], new Map(), []);
        expect(idMap.size).toBe(0);
        expect(items.map((i) => i.id)).toEqual([FOLDER.id, NOTE.id]);
        expect((items[1] as BackupNote).parent_id).toBe(FOLDER.id);
    });
});
