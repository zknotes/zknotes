import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { BackupFolder, BackupNote } from "./full-backup";
import { parseBackupZip } from "./full-backup-import";

function buildBackupZip(
    items: (BackupNote | BackupFolder)[],
    files: Record<string, Uint8Array> = {},
) {
    const entries: Record<string, Uint8Array> = {
        "manifest.json": strToU8(JSON.stringify({ version: 2, app: "zknotes" })),
        "items.json": strToU8(JSON.stringify(items)),
    };
    for (const [fileId, bytes] of Object.entries(files)) {
        entries[`files/${fileId}`] = bytes;
    }
    return zipSync(entries);
}

describe("parseBackupZip", () => {
    it("parses manifest, items and file map", () => {
        const note: BackupNote = {
            id: "note-1",
            type: "note",
            parent_id: null,
            sort_order: "m",
            title: "Hello",
            content: "<p>hi</p>",
            created_at: 1,
            updated_at: 2,
            version: 1,
        };
        const fileBytes = new Uint8Array([9, 8, 7]);
        const zip = buildBackupZip([note], { "file-1": fileBytes });

        const parsed = parseBackupZip(zip);
        expect(parsed.items).toEqual([note]);
        expect(parsed.fileMap.get("file-1")).toEqual(fileBytes);
    });

    it("throws when manifest.json is missing", () => {
        const zip = zipSync({ "items.json": strToU8("[]") });
        expect(() => parseBackupZip(zip)).toThrow("missing manifest.json");
    });

    it("throws on unsupported manifest version", () => {
        const zip = zipSync({
            "manifest.json": strToU8(JSON.stringify({ version: 1, app: "zknotes" })),
            "items.json": strToU8("[]"),
        });
        expect(() => parseBackupZip(zip)).toThrow("Unsupported backup format");
    });

    it("throws when items.json is missing", () => {
        const zip = zipSync({
            "manifest.json": strToU8(JSON.stringify({ version: 2, app: "zknotes" })),
        });
        expect(() => parseBackupZip(zip)).toThrow("missing items.json");
    });
});
