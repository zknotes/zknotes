#!/usr/bin/env bun
/**
 * Generates a demo vault as a ZKnotes backup ZIP.
 *
 *   bun scripts/make-demo-vault.ts [output.zip] [--seed <string>]
 *
 * Import it through Settings → Backup & Export → Restore from backup. The file is an ordinary v2
 * backup — the same container `exportFullBackup` writes and `parseBackupZip` reads:
 *
 *   manifest.json   {version: 2, app: "zknotes", …}
 *   items.json      the decrypted notes, folders and file metadata
 *   files/<itemId>  the attachment bytes
 *
 * Nothing in it is encrypted, which is exactly why it can be generated outside the app: the restore
 * wizard encrypts every item with a fresh Item Key as it stages them, so the demo lands in the
 * target vault like any other content. The vault password is never involved.
 *
 * Ids are derived from (seed, slug). Within one file they are stable, so re-importing it in
 * `skip_existing` mode is a no-op rather than a duplicate tree — but the seed is random per run,
 * because an item id is a GLOBAL primary key on the server: two vaults on one instance cannot hold
 * the same ids, and the second import would be rejected as a version drift. Pass `--seed` to
 * reproduce a file byte for byte, and only import that file into one vault per instance.
 *
 * Edit the content in `scripts/demo-vault/content.ts`.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { buildDemoVault } from "./demo-vault/content";
import type { BackupItem } from "./demo-vault/model";
import { ZipBuilder } from "./demo-vault/zip";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The restore wizard rejects a backup the server's schema will not accept, and a dangling
 * `data-file-id` silently renders an empty image. Both are cheaper to catch here.
 */
export function validate(items: BackupItem[], files: Map<string, Uint8Array>): string[] {
    const problems: string[] = [];
    const byId = new Map(items.map((item) => [item.id, item]));

    for (const item of items) {
        const label = `${item.type} ${"title" in item ? item.title : item.name}`;
        if (!UUID_RE.test(item.id)) problems.push(`${label}: id is not a UUIDv7 (${item.id})`);
        if (item.parent_id !== null && !byId.has(item.parent_id)) {
            problems.push(`${label}: parent ${item.parent_id} is not in the backup`);
        }
        if (item.type === "file") {
            const bytes = files.get(item.id);
            if (!bytes) problems.push(`${label}: no bytes under files/${item.id}`);
            else if (bytes.byteLength !== item.size) {
                problems.push(`${label}: size ${item.size} ≠ ${bytes.byteLength} bytes`);
            }
        }
    }

    // Every embedded attachment has to survive a round trip through the editor untouched: the file
    // must exist and hang off this note (the strict 1:1 model), `alt` must already be the name the
    // NodeView would sync in, and the img must stand as its own block — `encFile` is a block node,
    // so a paragraph around it leaves an empty one behind. Any of these and the note opens dirty.
    for (const item of items) {
        if (item.type !== "note") continue;
        for (const match of item.content.matchAll(/<img ([^>]*)data-file-id="([^"]+)"([^>]*)>/g)) {
            const attrs = `${match[1]}${match[3]}`;
            const referenced = byId.get(match[2] as string);
            if (referenced?.type !== "file") {
                problems.push(`note ${item.title}: data-file-id ${match[2]} has no file item`);
                continue;
            }
            if (referenced.parent_id !== item.id) {
                problems.push(
                    `note ${item.title}: embeds ${referenced.name}, whose parent is another item`,
                );
            }
            const alt = /alt="([^"]*)"/.exec(attrs)?.[1];
            if (alt !== referenced.name) {
                problems.push(
                    `note ${item.title}: embeds ${referenced.name} with alt="${alt}" — the editor ` +
                        "syncs alt to the file name",
                );
            }
            // Only an image has pixels for the editor to measure; a file chip carries no size.
            const isImage = referenced.mime.startsWith("image/");
            if (isImage && (!/data-w="\d+"/.test(attrs) || !/data-h="\d+"/.test(attrs))) {
                problems.push(`note ${item.title}: ${referenced.name} has no data-w/data-h`);
            }
        }
        if (/<p>\s*<img [^>]*data-file-id/.test(item.content)) {
            problems.push(`note ${item.title}: an attachment is wrapped in a paragraph`);
        }
    }

    // A file belongs to a note (the item routes refuse anything else, and so does a restore). One
    // with no parent at all is a legacy orphan the app offers to attach; a folder is never a parent.
    for (const item of items) {
        if (item.type !== "file" || item.parent_id === null) continue;
        if (byId.get(item.parent_id)?.type !== "note") {
            problems.push(`file ${item.name}: its parent is not a note`);
        }
    }

    for (const id of files.keys()) {
        if (!byId.has(id)) problems.push(`files/${id} has no item in items.json`);
    }
    return problems;
}

export function buildBackupZip(seed: string): {
    bytes: Uint8Array;
    items: BackupItem[];
    fileCount: number;
} {
    const { items, files } = buildDemoVault(seed);

    const problems = validate(items, files);
    if (problems.length > 0) {
        throw new Error(`The demo vault is inconsistent:\n  - ${problems.join("\n  - ")}`);
    }

    const zip = new ZipBuilder();
    zip.add(
        "manifest.json",
        `${JSON.stringify(
            {
                version: 2,
                app: "zknotes",
                created_at: new Date(0).toISOString(),
                item_count: items.length,
                file_count: files.size,
                encrypted: false,
            },
            null,
            2,
        )}\n`,
    );
    zip.add("items.json", JSON.stringify(items, null, 2));
    for (const [id, bytes] of files) {
        // PNG and PDF payloads are already compressed; deflating them again only costs time.
        zip.add(`files/${id}`, bytes, false);
    }

    return { bytes: zip.build(), items, fileCount: files.size };
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const seedAt = args.indexOf("--seed");
    let seed = randomBytes(8).toString("hex");
    let positional = args;
    if (seedAt >= 0) {
        seed = args[seedAt + 1] ?? "";
        if (!seed) throw new Error("--seed needs a value");
        positional = [...args.slice(0, seedAt), ...args.slice(seedAt + 2)];
    }
    const output = positional[0] ?? "demo-vault.zip";

    const { bytes, items, fileCount } = buildBackupZip(seed);
    writeFileSync(output, bytes);

    const counts = { note: 0, folder: 0, file: 0 };
    for (const item of items) counts[item.type] += 1;
    console.log(
        `${output} — ${counts.note} notes, ${counts.folder} folders, ${fileCount} attachments, ` +
            `${(bytes.byteLength / 1024).toFixed(1)} KiB`,
    );
    console.log(`Seed: ${seed}  (pass --seed ${seed} to rebuild this exact file)`);
    console.log("Import: Settings → Backup & Export → Restore from backup");
}
