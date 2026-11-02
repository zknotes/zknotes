// Parses (and decrypts) the full-backup ZIP that exportFullBackup produces.
// Importing to the server goes through the restore wizard — this module no longer has a push path.
import { strFromU8, unzipSync } from "fflate";
import { decryptBackup, isEncryptedBackup } from "./backup-crypto";
import type { BackupItem } from "./full-backup";

/** A file entry's name inside the archive: the item id, nothing more. */
const FILE_ENTRY_ID = /^[A-Za-z0-9_-]{1,128}$/;

export { isEncryptedBackup };

export type ImportMode = "overwrite" | "skip";

export interface ParsedBackup {
    items: BackupItem[];
    fileMap: Map<string, Uint8Array>; // fileId → the decrypted bytes
}

export function parseBackupZip(bytes: Uint8Array): ParsedBackup {
    const entries = unzipSync(bytes);

    const manifestEntry = entries["manifest.json"];
    if (!manifestEntry) throw new Error("Invalid backup: missing manifest.json");

    const manifest = JSON.parse(strFromU8(manifestEntry)) as {
        version: number;
        app: string;
    };
    if (manifest.app !== "zknotes" || manifest.version !== 2) {
        throw new Error(`Unsupported backup format (version ${manifest.version})`);
    }

    const itemsEntry = entries["items.json"];
    if (!itemsEntry) throw new Error("Invalid backup: missing items.json");

    const items = JSON.parse(strFromU8(itemsEntry)) as BackupItem[];

    // Only `files/<id>` is a file entry, and an id is one plain path segment. Anything else under
    // files/ — a nested path, `..`, a name with a slash or a dot — is not something a backup we
    // wrote contains, so it is left out rather than handed on as an id.
    const fileMap = new Map<string, Uint8Array>();
    for (const [path, data] of Object.entries(entries)) {
        if (path.startsWith("files/")) {
            const fileId = path.slice("files/".length);
            if (FILE_ENTRY_ID.test(fileId)) fileMap.set(fileId, data);
        }
    }

    return { items, fileMap };
}

/**
 * Decrypts the encrypted backup container with the given passphrase, then parses it as an
 * ordinary ZIP. Throws on a wrong password or a damaged stream (the message comes from
 * decryptBackup).
 */
export async function parseEncryptedBackupZip(
    bytes: Uint8Array,
    passphrase: string,
): Promise<ParsedBackup> {
    const zipBytes = await decryptBackup(bytes, passphrase);
    return parseBackupZip(zipBytes);
}
