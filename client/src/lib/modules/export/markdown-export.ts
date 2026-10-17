// The Markdown export: every live note as a `.md` file in a ZIP whose directories mirror the
// folder tree, with the attachments alongside. It decrypts on the client and streams the ZIP into a
// sink (a disk stream or the blob fallback); nothing leaves the browser.
//
// The structure:
//   <folder-path>/<note-title>.md                — the note as Markdown
//   _attachments/<fileId>/<name>                 — the files (embedded images always, the rest with
//                                                  includeFiles)
//
// It shares the HTML export's content rewrite, so images point at their attachment and links
// between notes point at the other note's `.md` file, both as relative paths.

import type { FilePayload, NotePayload } from "@zknotes/shared";
import { strToU8 } from "fflate";
import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import { sanitizeHtml } from "$lib/core/utils/dompurify";
import { htmlToMarkdown } from "$lib/core/utils/html-to-md";
import { extractFileRefs } from "$lib/modules/files/refs";
import { rewriteContent } from "./html-export";
import { type BackupSink, createBackupSink, ZipStreamWriter } from "./sink";
import {
    buildItemPath,
    ExportRun,
    type ExportResult,
    loadLiveItems,
    type PathMeta,
    safeName,
} from "./utils";

export interface MarkdownExportProgress {
    phase: "notes" | "files" | "zipping";
    done: number;
    total: number;
}

export interface MarkdownExportOptions {
    /** Standalone attachments too; images embedded in a note are always included. */
    includeFiles?: boolean;
    onProgress?: (p: MarkdownExportProgress) => void;
    /** For tests: the sink to write into instead of asking for a file. */
    sink?: BackupSink;
}

interface NoteEntry {
    title: string;
    content: string;
    path: string;
    depth: number;
}

/** A ZIP path as a Markdown link destination: each segment URL-encoded, so spaces do not end it. */
function linkPath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

export async function exportMarkdown(options: MarkdownExportOptions = {}): Promise<ExportResult> {
    const { includeFiles = true, onProgress } = options;
    const date = new Date().toISOString().slice(0, 10);

    // Open the sink while the user gesture (the transient activation) for showSaveFilePicker still holds.
    const sink: BackupSink =
        options.sink ??
        (await createBackupSink(`zknotes-markdown-${date}.zip`, "application/zip", {
            "application/zip": [".zip"],
        }));

    const live = await loadLiveItems();
    const noteItems = live.filter((i) => i.type === "note");
    const folderItems = live.filter((i) => i.type === "folder");
    const fileItems = live.filter((i) => i.type === "file");

    // Folder titles name the directories, so they are decrypted first.
    const metaById = new Map<string, PathMeta>();
    for (const item of live) {
        metaById.set(item.id, { parent_id: item.parent_id, title: "Untitled", type: item.type });
    }
    for (const folder of folderItems) {
        try {
            const payload = await decryptItemPayload<{ title?: string }>(folder);
            // biome-ignore lint/style/noNonNullAssertion: metaById contains every live item
            metaById.get(folder.id)!.title = payload.title || "Untitled";
        } catch (e) {
            console.warn(`Markdown export: skipping folder title ${folder.id}`, e);
        }
    }

    const fileNameById = new Map<string, string>();
    for (const file of fileItems) {
        try {
            const payload = await decryptItemPayload<FilePayload>(file);
            fileNameById.set(file.id, safeName(payload.name || file.id));
        } catch (e) {
            console.warn(`Markdown export: skipping file name ${file.id}`, e);
        }
    }

    const zw = new ZipStreamWriter(sink);
    const run = new ExportRun<MarkdownExportProgress>(
        noteItems.length + fileItems.length,
        onProgress,
    );

    try {
        // ── Pass 1: decrypt the notes and fix every path, so links can point at any of them ──
        const notes: NoteEntry[] = [];
        const notePathById = new Map<string, string>();
        const referencedFileIds = new Set<string>();
        const usedPaths = new Set<string>();

        run.emit("notes");
        for (const item of noteItems) {
            try {
                const payload = await decryptItemPayload<Partial<NotePayload>>(item);
                const title = payload.title || "Untitled";
                const content = payload.content ?? "";
                for (const id of extractFileRefs(content)) referencedFileIds.add(id);

                const folder = buildItemPath(item.id, metaById);
                const base = folder ? `${folder}/${safeName(title)}` : safeName(title);
                // Two notes of the same name in one folder would otherwise be two entries of one
                // name, and an unzip keeps only one of them.
                let path = `${base}.md`;
                for (let n = 2; usedPaths.has(path); n++) path = `${base} (${n}).md`;
                usedPaths.add(path);

                notes.push({
                    title,
                    content,
                    path,
                    depth: folder ? folder.split("/").length : 0,
                });
                notePathById.set(item.id, linkPath(path));
            } catch (e) {
                run.skip(item, e, "Markdown export");
            }
            run.done++;
            run.emit("notes");
        }

        // ── Pass 2: Markdown ────────────────────────────────────────────────────────────────
        for (const note of notes) {
            const prefix = "../".repeat(note.depth);
            const html = rewriteContent(
                sanitizeHtml(note.content),
                prefix,
                fileNameById,
                notePathById,
            );
            const markdown = `# ${note.title}\n\n${htmlToMarkdown(html)}`;
            await zw.addFile(note.path, strToU8(markdown), true);
        }

        // ── Attachments: the embedded images always; standalone files only with includeFiles ──
        const filesToWrite = fileItems.filter((f) => referencedFileIds.has(f.id) || includeFiles);
        run.done += fileItems.length - filesToWrite.length;

        const { decryptFile } = await import("$lib/modules/files/download");
        await run.stage("files", filesToWrite, "Markdown export", async (item) => {
            // The same one-shot read as the HTML export: fetch what this device never downloaded,
            // and leave the offline cache alone.
            const result = await decryptFile(item.id, undefined, {
                forceDownload: true,
                persist: false,
            });
            const name = fileNameById.get(item.id) || safeName(result.name || item.id);
            await zw.addFile(`_attachments/${item.id}/${name}`, result.bytes, false);
        });

        run.emit("zipping");
        await zw.finish();
        await sink.close();
    } catch (e) {
        await sink.abort(e).catch(() => {});
        throw e;
    }
    return { skipped: run.skipped };
}
