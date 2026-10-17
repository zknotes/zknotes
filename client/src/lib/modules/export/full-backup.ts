// A full-fidelity backup: it decrypts every non-deleted item on the client and streams them into a
// ZIP. Notes and folders are stored as decrypted metadata plus HTML content in items.json.
// File attachments are stored as decrypted raw bytes under files/<itemId>.
// The resulting ZIP comes back through the restore wizard (restore-wizard.ts); this module only
// exports.
//
// The ZIP is built incrementally (ZipStreamWriter) and streamed into a sink (an FS Access disk
// stream, or the blob fallback) → the peak memory is about one entry, not the whole vault.
// With `encrypt` + `passphrase` the entire stream is encrypted (BackupEncryptor), so plaintext
// never reaches the disk; without it the ZIP is plaintext (with a warning in the UI).

import type { FilePayload, NotePayload } from "@zknotes/shared";
import { strToU8 } from "fflate";
import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import { decryptFile } from "$lib/modules/files/download";
import { BackupEncryptor, ENCRYPTED_BACKUP_EXT } from "./backup-crypto";
import { type BackupSink, createBackupSink, encryptedSink, ZipStreamWriter } from "./sink";
import { type ExportResult, ExportRun, loadLiveItems } from "./utils";

export interface FullBackupProgress {
    phase: "notes" | "files" | "zipping";
    done: number;
    total: number;
}

export interface FullBackupOptions {
    /** A password-protected (encrypted) backup; it requires a `passphrase`. */
    encrypt?: boolean;
    passphrase?: string;
    /** Include the file attachments (raw bytes). `false` → a backup of notes and folders only. `true` by default. */
    includeFiles?: boolean;
    onProgress?: (p: FullBackupProgress) => void;
    /**
     * An injected sink (for tests, or a programmatic export). When given, it skips
     * showSaveFilePicker / the blob download — the result goes only into this sink.
     */
    sink?: import("./sink").BackupSink;
}

export interface BackupNote {
    id: string;
    type: "note";
    parent_id: string | null;
    sort_order: string;
    title: string;
    content: string; // the HTML exactly as it is in the encrypted payload
    /** The title derived from the first line of the content — omitted when the original has none. */
    contentTitle?: string;
    color?: string;
    icon?: string;
    starred?: boolean;
    /** A per-note override of the outline's visibility. Three states: undefined = follow the global default. */
    outlineVisible?: boolean;
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

export async function exportFullBackup(options: FullBackupOptions = {}): Promise<ExportResult> {
    const { encrypt, passphrase, includeFiles = true, onProgress } = options;
    if (encrypt && !passphrase) throw new Error("Passphrase is required for an encrypted backup.");

    const date = new Date().toISOString().slice(0, 10);
    const filename = encrypt
        ? `zknotes-backup-${date}.${ENCRYPTED_BACKUP_EXT}`
        : `zknotes-backup-${date}.zip`;
    const mime = encrypt ? "application/octet-stream" : "application/zip";
    const accept: Record<string, string[]> = encrypt
        ? { "application/octet-stream": [`.${ENCRYPTED_BACKUP_EXT}`] }
        : { "application/zip": [".zip"] };

    // Open the sink BEFORE decrypting: showSaveFilePicker has to flow from a user gesture (a
    // transient activation), and cancelling the dialog (BackupAbortedError) then costs no CPU on
    // decryption. `options.sink` lets tests and a programmatic export capture the bytes with no UI.
    let sink: BackupSink = options.sink ?? (await createBackupSink(filename, mime, accept));
    if (encrypt && passphrase) {
        sink = encryptedSink(sink, await BackupEncryptor.create(passphrase));
    }

    const live = await loadLiveItems();
    const notesAndFolders = live.filter((i) => i.type === "note" || i.type === "folder");
    // includeFiles=false → skip the file stage and write no files/<id> into the ZIP.
    const fileItems = includeFiles ? live.filter((i) => i.type === "file") : [];

    const zw = new ZipStreamWriter(sink);
    const backupItems: BackupItem[] = [];
    // The files that really reached the ZIP — manifest.file_count must match files/<id>.
    let filesWritten = 0;
    const run = new ExportRun<FullBackupProgress>(
        notesAndFolders.length + fileItems.length,
        onProgress,
    );

    try {
        await run.stage("notes", notesAndFolders, "Full backup", async (item) => {
            const payload = await decryptItemPayload<Partial<NotePayload>>(item);
            const base = {
                id: item.id,
                parent_id: item.parent_id ?? null,
                sort_order: item.sort_order,
                title: payload.title || "Untitled",
                created_at: item.created_at ?? 0,
                updated_at: item.updated_at ?? 0,
                version: item.version,
                ...(payload.color ? { color: payload.color } : {}),
                ...(payload.icon ? { icon: payload.icon } : {}),
                ...(payload.starred !== undefined ? { starred: payload.starred } : {}),
            };
            if (item.type === "note") {
                backupItems.push({
                    ...base,
                    type: "note",
                    content: payload.content ?? "",
                    // Omit it when the original has none — do not write "" for undefined,
                    // or the import re-encrypts a narrower JSON and items_bytes shrinks after the
                    // restore.
                    ...(payload.contentTitle !== undefined
                        ? { contentTitle: payload.contentTitle }
                        : {}),
                    // `false` is not the same as `undefined` (which follows the global default) — it must not be
                    // squeezed out by a truthy check the way color/icon/starred are.
                    ...(payload.outlineVisible !== undefined
                        ? { outlineVisible: payload.outlineVisible }
                        : {}),
                });
            } else {
                backupItems.push({ ...base, type: "folder" });
            }
        });

        await run.stage("files", fileItems, "Full backup", async (item) => {
            // decryptFile caches the Item Key internally — the payload decrypt below reuses that
            // cache. persist:false — a backup is a one-shot read of the whole vault; it must not fill
            // or evict the offline chunk cache. forceDownload — the
            // device's auto-download policy decides what to cache for viewing, not what a backup
            // holds; without it a file this device never fetched was left out.
            const result = await decryptFile(item.id, undefined, {
                forceDownload: true,
                persist: false,
            });
            const payload = await decryptItemPayload<FilePayload>(item);

            backupItems.push({
                id: item.id,
                type: "file",
                parent_id: item.parent_id ?? null,
                sort_order: item.sort_order,
                name: payload.name || result.name,
                mime: payload.mime || result.declaredMime,
                size: result.bytes.byteLength,
                created_at: item.created_at ?? 0,
                updated_at: item.updated_at ?? 0,
                version: item.version,
                ...(payload.description ? { description: payload.description } : {}),
            });

            // Already-compressed binary content → store it (no deflate), one item in memory.
            await zw.addFile(`files/${item.id}`, result.bytes, false);
            filesWritten++;
        });

        run.emit("zipping");

        const manifest = strToU8(
            JSON.stringify(
                {
                    version: 2,
                    app: "zknotes",
                    created_at: new Date().toISOString(),
                    item_count: backupItems.length,
                    file_count: filesWritten,
                    encrypted: Boolean(encrypt),
                },
                null,
                2,
            ),
        );
        await zw.addFile("manifest.json", manifest, true);
        await zw.addFile("items.json", strToU8(JSON.stringify(backupItems, null, 2)), true);

        await zw.finish();
        await sink.close();
    } catch (e) {
        await sink.abort(e).catch(() => {});
        throw e;
    }
    return { skipped: run.skipped };
}
