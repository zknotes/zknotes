import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildDemoVault } from "./demo-vault/content";
import type { BackupItem } from "./demo-vault/model";
import { buildBackupZip, validate } from "./make-demo-vault";

const SEED = "test-seed";

/**
 * The generator writes a container that only the app ever reads back, so the value of these tests is
 * in proving the two halves it cannot see: that the ZIP really parses, and that the validator would
 * actually fail on the mistakes it claims to catch.
 */

/**
 * A minimal reader for the container ZipBuilder writes — local headers in order, no data
 * descriptors, no ZIP64. Deliberately independent of the writer's own bookkeeping.
 */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = new Map<string, Uint8Array>();
    let at = 0;
    while (at + 4 <= bytes.byteLength && view.getUint32(at, true) === 0x04034b50) {
        const method = view.getUint16(at + 8, true);
        const compressedSize = view.getUint32(at + 18, true);
        const nameLength = view.getUint16(at + 26, true);
        const extraLength = view.getUint16(at + 28, true);
        const nameAt = at + 30;
        const dataAt = nameAt + nameLength + extraLength;
        const name = new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLength));
        const payload = bytes.subarray(dataAt, dataAt + compressedSize);
        entries.set(name, method === 8 ? new Uint8Array(inflateRawSync(payload)) : payload);
        at = dataAt + compressedSize;
    }
    return entries;
}

describe("the demo vault content", () => {
    const { items, files } = buildDemoVault(SEED);
    const notes = items.filter((item) => item.type === "note");

    it("has enough of a tree to be worth testing against", () => {
        expect(notes.length).toBeGreaterThanOrEqual(10);
        expect(items.filter((item) => item.type === "folder").length).toBeGreaterThanOrEqual(3);
        expect(files.size).toBeGreaterThanOrEqual(4);
    });

    it("is internally consistent", () => {
        expect(validate(items, files)).toEqual([]);
    });

    it("is byte-for-byte reproducible for one seed", () => {
        expect(buildBackupZip(SEED).bytes).toEqual(buildBackupZip(SEED).bytes);
    });

    // An item id is a global primary key on the server: if two generated vaults shared ids, the
    // second one to be imported on an instance would be rejected as a version drift.
    it("gives every seed its own ids", () => {
        const other = buildDemoVault("another-seed");
        const mine = new Set(items.map((item) => item.id));
        expect(other.items.some((item) => mine.has(item.id))).toBe(false);
    });

    it("exercises the editor features it claims to", () => {
        const html = notes.map((note) => (note.type === "note" ? note.content : "")).join("");
        for (const shape of [
            "<h1>",
            "<blockquote>",
            "<table>",
            "<pre><code",
            'data-type="taskList"',
            'data-type="inlineMath"',
            "data-file-id=",
            'data-type="mention"',
            "<mark ",
            "<sub>",
            "<sup>",
            "<hr>",
        ]) {
            expect(html, `missing ${shape}`).toContain(shape);
        }
    });

    it("keeps every attachment small", () => {
        for (const [id, bytes] of files) {
            expect(bytes.byteLength, id).toBeLessThan(64 * 1024);
        }
    });
});

describe("validate", () => {
    const base = (): { items: BackupItem[]; files: Map<string, Uint8Array> } => {
        const built = buildDemoVault(SEED);
        return { items: [...built.items], files: new Map(built.files) };
    };

    it("catches an id the server's schema would reject", () => {
        const { items, files } = base();
        const target = items.find((item) => item.type === "folder") as BackupItem;
        const broken = { ...target, id: "not-a-uuid" };
        expect(validate([...items.filter((i) => i !== target), broken], files).join()).toContain(
            "not a UUIDv7",
        );
    });

    it("catches an inline attachment that is not a child of its note", () => {
        const { items, files } = base();
        const embedded = items.find(
            (item) => item.type === "file" && item.name.endsWith(".png"),
        ) as BackupItem;
        const moved = { ...embedded, parent_id: null };
        const problems = validate([...items.filter((i) => i !== embedded), moved], files);
        expect(problems.join()).toContain("whose parent is another item");
    });

    it("catches a file placed directly in a folder", () => {
        const { items, files } = base();
        const file = items.find((item) => item.type === "file" && item.parent_id) as BackupItem;
        const folder = items.find((item) => item.type === "folder") as BackupItem;
        const moved = { ...file, parent_id: folder.id };
        const problems = validate([...items.filter((i) => i !== file), moved], files);
        expect(problems.join()).toContain("its parent is not a note");
    });

    it("catches a file item with no bytes behind it", () => {
        const { items, files } = base();
        const [firstFileId] = [...files.keys()];
        files.delete(firstFileId as string);
        expect(validate(items, files).join()).toContain("no bytes under files/");
    });
});

describe("the backup container", () => {
    const { bytes, items, fileCount } = buildBackupZip(SEED);
    const entries = readZip(bytes);

    it("parses back as a ZIP with the entries the importer looks for", () => {
        expect([...entries.keys()]).toContain("manifest.json");
        expect([...entries.keys()]).toContain("items.json");
        expect([...entries.keys()].filter((name) => name.startsWith("files/"))).toHaveLength(
            fileCount,
        );
    });

    it("declares the v2 format parseBackupZip accepts", () => {
        const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")));
        expect(manifest).toMatchObject({ app: "zknotes", version: 2, encrypted: false });
        expect(manifest.item_count).toBe(items.length);
    });

    it("round-trips items.json", () => {
        const parsed = JSON.parse(new TextDecoder().decode(entries.get("items.json")));
        expect(parsed).toEqual(items);
    });
});
