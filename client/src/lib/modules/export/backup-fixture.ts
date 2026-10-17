// A predictable vault fixture for the full-backup round-trip tests (no UI).
// Every id, title and body is fixed — the assertions are deterministic.
//
// The tree:
//   Projects/                  (folder)
//     Nested/                  (folder)
//       Deep note              (note)
//     Hello                    (note + attachment file-under-note)
//     readme.txt               (file)
//     dot.png                  (file, a small PNG header)
//   Empty folder               (folder, no children)
//   Empty note                 (note, empty content)
//   Unicode 🔐                 (note, non-ASCII)
//   Long note                  (note, ~50 KiB HTML)
//   Colored                    (note with a color+icon)
//   multi.bin                  (file, multi-chunk at seed time — 2 small chunks)
//   empty.bin                  (file, 0 plaintext bytes)

import type { BackupFile, BackupFolder, BackupItem, BackupNote } from "./full-backup";
import type { ParsedBackup } from "./full-backup-import";

/** Stable IDs — not real UUIDv7s; crypto and IDB do not require the format. */
export const FIXTURE_IDS = {
    folderRoot: "fix-folder-root",
    folderNested: "fix-folder-nested",
    folderEmpty: "fix-folder-empty",
    notePlain: "fix-note-plain",
    noteUnicode: "fix-note-unicode",
    noteEmpty: "fix-note-empty",
    noteLong: "fix-note-long",
    noteColored: "fix-note-colored",
    noteDeep: "fix-note-deep",
    fileText: "fix-file-text",
    filePng: "fix-file-png",
    fileUnderNote: "fix-file-under-note",
    fileMulti: "fix-file-multi",
    fileEmpty: "fix-file-empty",
} as const;

const LONG_BODY = `<p>${"Lorem ipsum dolor sit amet. ".repeat(2000)}</p>`;

/** A minimal PNG signature + an IHDR placeholder — enough for the sniffer and the export, but not a valid PNG. */
export const FIXTURE_PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde,
]);

export const FIXTURE_TEXT_BYTES = new TextEncoder().encode("Hello from backup fixture readme.\n");
/** 24 bytes → a seed with chunkSize=12 gives 2 chunks (the multi-chunk path in export/decrypt). */
export const FIXTURE_MULTI_BYTES = new TextEncoder().encode("AAAABBBBCCCCDDDDEEEEFFFF");
export const FIXTURE_EMPTY_BYTES = new Uint8Array(0);
export const FIXTURE_NOTE_ATTACHMENT_BYTES = new TextEncoder().encode("attached-to-note");

/** A multi-chunk seed: a fixed small chunk size (only in the fixture seed, never in a real upload). */
export const FIXTURE_MULTI_CHUNK_SIZE = 12;

function note(
    partial: Omit<BackupNote, "type" | "created_at" | "updated_at" | "version" | "sort_order"> & {
        sort_order?: string;
        created_at?: number;
        updated_at?: number;
        version?: number;
    },
): BackupNote {
    return {
        type: "note",
        sort_order: partial.sort_order ?? partial.id,
        created_at: partial.created_at ?? 1_700_000_000,
        updated_at: partial.updated_at ?? 1_700_000_100,
        version: partial.version ?? 1,
        id: partial.id,
        parent_id: partial.parent_id,
        title: partial.title,
        content: partial.content,
        ...(partial.color ? { color: partial.color } : {}),
        ...(partial.icon ? { icon: partial.icon } : {}),
        ...(partial.starred ? { starred: true } : {}),
        ...(partial.contentTitle !== undefined ? { contentTitle: partial.contentTitle } : {}),
        ...(partial.outlineVisible !== undefined ? { outlineVisible: partial.outlineVisible } : {}),
    };
}

function folder(
    partial: Omit<BackupFolder, "type" | "created_at" | "updated_at" | "version" | "sort_order"> & {
        sort_order?: string;
        created_at?: number;
        updated_at?: number;
        version?: number;
    },
): BackupFolder {
    return {
        type: "folder",
        sort_order: partial.sort_order ?? partial.id,
        created_at: partial.created_at ?? 1_700_000_000,
        updated_at: partial.updated_at ?? 1_700_000_100,
        version: partial.version ?? 1,
        id: partial.id,
        parent_id: partial.parent_id,
        title: partial.title,
        ...(partial.color ? { color: partial.color } : {}),
        ...(partial.icon ? { icon: partial.icon } : {}),
        ...(partial.starred ? { starred: true } : {}),
    };
}

function file(
    partial: Omit<
        BackupFile,
        "type" | "created_at" | "updated_at" | "version" | "sort_order" | "size"
    > & {
        sort_order?: string;
        created_at?: number;
        updated_at?: number;
        version?: number;
        size?: number;
        bytes: Uint8Array;
    },
): BackupFile & { bytes: Uint8Array } {
    return {
        type: "file",
        sort_order: partial.sort_order ?? partial.id,
        created_at: partial.created_at ?? 1_700_000_000,
        updated_at: partial.updated_at ?? 1_700_000_100,
        version: partial.version ?? 1,
        id: partial.id,
        parent_id: partial.parent_id,
        name: partial.name,
        mime: partial.mime,
        size: partial.size ?? partial.bytes.byteLength,
        bytes: partial.bytes,
        ...(partial.description ? { description: partial.description } : {}),
    };
}

/** The complete parsed backup shape (items + fileMap), ready for the restore wizard. */
export function buildFixtureParsedBackup(): ParsedBackup {
    const { items, fileMap } = buildFixtureVault();
    return { items, fileMap };
}

export interface FixtureVault {
    items: BackupItem[];
    fileMap: Map<string, Uint8Array>;
    /** A lookup by id, for the assertions. */
    byId: Map<string, BackupItem>;
}

/**
 * Builds the predictable vault: nested folders, edge-case notes, files in a folder and under a note,
 * a multi-chunk one and an empty one.
 */
export function buildFixtureVault(): FixtureVault {
    const folders: BackupFolder[] = [
        folder({
            id: FIXTURE_IDS.folderRoot,
            parent_id: null,
            title: "Projects",
            sort_order: "a0",
        }),
        folder({
            id: FIXTURE_IDS.folderNested,
            parent_id: FIXTURE_IDS.folderRoot,
            title: "Nested",
            starred: true,
            sort_order: "a1",
        }),
        folder({
            id: FIXTURE_IDS.folderEmpty,
            parent_id: null,
            title: "Empty folder",
            sort_order: "a2",
        }),
    ];

    const notes: BackupNote[] = [
        note({
            id: FIXTURE_IDS.notePlain,
            parent_id: FIXTURE_IDS.folderRoot,
            title: "Hello",
            content: "<p>Hello world</p>",
            sort_order: "b0",
        }),
        note({
            id: FIXTURE_IDS.noteDeep,
            parent_id: FIXTURE_IDS.folderNested,
            title: "Deep note",
            content: "<p>Nested content</p>",
            sort_order: "b1",
        }),
        note({
            id: FIXTURE_IDS.noteEmpty,
            parent_id: null,
            title: "Empty note",
            content: "",
            sort_order: "b2",
        }),
        note({
            id: FIXTURE_IDS.noteUnicode,
            parent_id: null,
            title: "Unicode 🔐",
            content: "<p>Čćžšđ 日本語</p>",
            sort_order: "b3",
        }),
        note({
            id: FIXTURE_IDS.noteLong,
            parent_id: null,
            title: "Long note",
            content: LONG_BODY,
            contentTitle: "Long note (derived title)",
            outlineVisible: false,
            sort_order: "b4",
        }),
        note({
            id: FIXTURE_IDS.noteColored,
            parent_id: null,
            title: "Colored",
            content: "<p>with style</p>",
            color: "#ff5500",
            icon: "star",
            starred: true,
            outlineVisible: true,
            sort_order: "b5",
        }),
    ];

    const filesWithBytes = [
        file({
            id: FIXTURE_IDS.fileText,
            parent_id: FIXTURE_IDS.folderRoot,
            name: "readme.txt",
            mime: "text/plain",
            bytes: FIXTURE_TEXT_BYTES,
            description: "fixture text file",
            sort_order: "c0",
        }),
        file({
            id: FIXTURE_IDS.filePng,
            parent_id: FIXTURE_IDS.folderRoot,
            name: "dot.png",
            mime: "image/png",
            bytes: FIXTURE_PNG_BYTES,
            sort_order: "c1",
        }),
        file({
            id: FIXTURE_IDS.fileUnderNote,
            parent_id: FIXTURE_IDS.notePlain,
            name: "attachment.txt",
            mime: "text/plain",
            bytes: FIXTURE_NOTE_ATTACHMENT_BYTES,
            sort_order: "c2",
        }),
        file({
            id: FIXTURE_IDS.fileMulti,
            parent_id: null,
            name: "multi.bin",
            mime: "application/octet-stream",
            bytes: FIXTURE_MULTI_BYTES,
            sort_order: "c3",
        }),
        file({
            id: FIXTURE_IDS.fileEmpty,
            parent_id: null,
            name: "empty.bin",
            mime: "application/octet-stream",
            bytes: FIXTURE_EMPTY_BYTES,
            sort_order: "c4",
        }),
    ];

    const fileMap = new Map<string, Uint8Array>();
    const backupFiles: BackupFile[] = [];
    for (const f of filesWithBytes) {
        const { bytes, ...meta } = f;
        fileMap.set(f.id, bytes);
        backupFiles.push(meta);
    }

    const items: BackupItem[] = [...folders, ...notes, ...backupFiles];
    const byId = new Map(items.map((i) => [i.id, i]));
    return { items, fileMap, byId };
}

/** The expected number of entries per type (for the smoke assertion). */
export function fixtureCounts(): { folders: number; notes: number; files: number; total: number } {
    const { items } = buildFixtureVault();
    const folders = items.filter((i) => i.type === "folder").length;
    const notes = items.filter((i) => i.type === "note").length;
    const files = items.filter((i) => i.type === "file").length;
    return { folders, notes, files, total: items.length };
}
