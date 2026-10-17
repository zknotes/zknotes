// A readable HTML export. It decrypts every non-deleted note on the client and builds a folder-mirrored
// structure, then streams a ZIP. Unlike the full backup (restorable, opaque) this one is VIEW-ONLY and
// readable locally without the application: every note is a standalone `.html` page, plus a
// self-contained `index.html` browser with a tree sidebar. The data is written to disk UNENCRYPTED
// (the UI warns about this).
//
// The structure:
//   index.html                      — the browser (sidebar + content pane), with no external resources
//   _attachments/<fileId>/<name>     — the decrypted attachments (at the root; pages reference them relatively)
//   <folder-path>/<note-title>.html  — a standalone page per note
//
// Inline images are `<img data-file-id="…">` (the encFile node) → they are rewritten into a relative
// `src` pointing at `_attachments/<id>/<name>`. Inline images are ALWAYS included (otherwise the pages
// break); standalone file items (attachments in folders) only with `includeFiles`.

import type { FilePayload, NotePayload } from "@zknotes/shared";
import { strToU8 } from "fflate";
import { decryptItemPayload } from "$lib/core/crypto/item-codec";
import { escapeHtml, sanitizeHtml } from "$lib/core/utils/dompurify";
import { applyPresentationFromAttrs } from "$lib/core/utils/table-attrs";
import { extractFileRefs } from "$lib/modules/files/refs";
import { isRasterImageMime } from "$lib/modules/files/sniff";
import { type BackupSink, createBackupSink, ZipStreamWriter } from "./sink";
import {
    buildItemPath,
    type ExportResult,
    ExportRun,
    loadLiveItems,
    type PathMeta,
    safeName,
} from "./utils";

export interface HtmlExportProgress {
    phase: "notes" | "files" | "zipping";
    done: number;
    total: number;
}

export interface HtmlExportOptions {
    /** Include standalone file items (attachments in folders). Inline images are always included. `true` by default. */
    includeFiles?: boolean;
    onProgress?: (p: HtmlExportProgress) => void;
    /** An injected sink (tests, a programmatic export), as in `FullBackupOptions` — skips the dialog. */
    sink?: BackupSink;
}

interface NoteEntry {
    id: string;
    type: "note";
    parentId: string | null;
    sortOrder: string;
    title: string;
    content: string;
    folder: string;
    path: string; // <folder>/<title>.html
    depth: number;
}

interface TreeNode {
    id: string;
    type: "note" | "folder";
    title: string;
    parentId: string | null;
    sortOrder: string;
    html?: string; // notes only — viewer-inline (root-relative img src)
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

/**
 * Rewrites a note's HTML for offline viewing:
 *   - `<img data-file-id>` images → a relative `src` pointing at `_attachments/<id>/<name>`
 *   - `<img data-file-id>` non-images (PDF, docx…) → an `<a download>` link
 *   - mention links → a relative path to the .html (standalone) or a data-note-id for the JS (viewer)
 * Defensively strips `<script>` and inline `on*` handlers. Returns the `<body>`'s inner HTML.
 *
 * @param notePathById  A map of noteId → the .html file's path inside the ZIP. When it is undefined we
 *                      are in viewer mode: mention links get a data-note-id for the JS click.
 */
/**
 * Rewrites a note's sanitised HTML for a file on disk: embedded files point at their attachment
 * under `prefix`, and links between notes at `notePathById` (or, without it, at the viewer). The
 * Markdown export shares it.
 */
export function rewriteContent(
    content: string,
    prefix: string,
    fileNameById: Map<string, string>,
    notePathById: Map<string, string> | undefined,
): string {
    const doc = new DOMParser().parseFromString(content, "text/html");

    // `sanitizeHtml` strips every inline `style`. The user's table widths, row heights, table
    // properties and image widths survive only as validated `data-*` / `width` attributes — rebuild
    // the style from them, exactly as the share render does, or the export loses them.
    applyPresentationFromAttrs(doc);

    // A defensive clean-up: this is the user's own data, but it is rendered through innerHTML in a
    // static HTML file, so the active vectors are removed. We cover:
    //   - the active elements (script, iframe, object, embed, base)
    //   - the event-handler attributes (on*)
    //   - the dangerous URL schemes in href/src/action/formaction (javascript:, vbscript:, data:)
    for (const el of Array.from(doc.querySelectorAll("script, iframe, object, embed, base")))
        el.remove();
    const UNSAFE_URL_RE = /^\s*(javascript|vbscript|data):/i;
    const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "data"]);
    for (const el of Array.from(doc.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on")) {
                el.removeAttribute(attr.name);
            } else if (URL_ATTRS.has(name) && UNSAFE_URL_RE.test(attr.value)) {
                el.removeAttribute(attr.name);
            }
        }
    }

    // Rewrite the encFile nodes. Images → <img src>, non-images → <a download>.
    for (const img of Array.from(doc.querySelectorAll("img[data-file-id]"))) {
        const fileId = img.getAttribute("data-file-id") ?? "";
        const mime = img.getAttribute("data-mime") ?? "";
        const name = fileNameById.get(fileId);

        img.removeAttribute("data-file-id");
        img.removeAttribute("data-mime");
        img.removeAttribute("data-error");

        if (!name) continue;

        const src = `${prefix}_attachments/${fileId}/${encodeURIComponent(name)}`;
        const isImage = isRasterImageMime(mime) || (!mime && IMAGE_EXT_RE.test(name));

        if (isImage) {
            img.setAttribute("src", src);
        } else {
            // Non-images (PDF, docx, zip…) are shown as a download link rather than a broken image.
            const a = doc.createElement("a");
            a.href = src;
            a.setAttribute("download", name);
            a.textContent = name;
            a.className = "file-attachment";
            img.parentNode?.replaceChild(a, img);
        }
    }

    // Rewrite the mention links (note-to-note references).
    for (const a of Array.from(doc.querySelectorAll('a[data-type="mention"]'))) {
        const noteId = (a.getAttribute("data-note-id") || a.getAttribute("data-id")) ?? "";
        if (notePathById) {
            // A standalone page: rewrite the href to a relative path to the target .html page.
            const targetPath = notePathById.get(noteId);
            if (targetPath) {
                a.setAttribute("href", `${prefix}${targetPath}`);
            } else {
                a.removeAttribute("href");
            }
            a.removeAttribute("data-note-id");
        } else {
            // Viewer mode: href="#" + data-note-id — the viewer JS intercepts the click and opens the note.
            a.setAttribute("href", "#");
            if (noteId) a.setAttribute("data-note-id", noteId);
        }
        // Remove the app-specific attributes that make no sense in static HTML.
        a.removeAttribute("data-type");
        a.removeAttribute("data-id");
        a.removeAttribute("data-label");
        a.removeAttribute("contenteditable");
        a.classList.remove("note-link");
    }

    return doc.body.innerHTML;
}

/** The minimal base styles the standalone pages and the browser share. */
// Tables in the export. The width arrives as an inline `style="width: N%"` rebuilt by
// `applyPresentationFromAttrs` from `data-user-width` (the sanitiser strips the editor's own inline
// style) — only borders and typography live here, with no width, so nothing fights the user's value.
const TABLE_CSS = `
    table { border-collapse: collapse; margin: 1.2em 0; font-size: 0.925em; }
    th, td { border: var(--tbl-bw, 1px) var(--tbl-bs, solid) var(--tbl-bc, #ddd);
        padding: var(--tbl-pad, 0.5em 0.9em); vertical-align: top; }
    th { background: #f4f4f5; font-weight: 600; text-align: left; }
    table caption { caption-side: top; text-align: left; font-size: 0.9em; color: #52525b;
        padding-bottom: 0.4em; }
    table col { min-width: 25px; }`;

const TABLE_CSS_DARK = `
        th, td { border-color: var(--tbl-bc, #3f3f46); }
        th { background: #27272a; }
        table caption { color: #a1a1aa; }`;

const BASE_CSS = `
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.6;
        max-width: 820px; margin: 0 auto; padding: 2rem 1.25rem; color: #1a1a1a; background: #fff; }
    h1, h2, h3 { line-height: 1.25; }
    img { max-width: 100%; height: auto; border-radius: 6px; }
    pre { background: #f4f4f5; padding: 1rem; border-radius: 8px; overflow: auto; }
    code { background: #f4f4f5; padding: 0.1em 0.3em; border-radius: 4px; }
    blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 1rem; color: #555; }
    a { color: #2563eb; }
    a.file-attachment { display: inline-flex; align-items: center; gap: 0.3em; padding: 0.2em 0.5em;
        background: #f4f4f5; border-radius: 4px; text-decoration: none; font-size: 0.9em; }
    a.file-attachment::before { content: "📎"; }
    ul[data-type="taskList"] { list-style: none; padding-left: 0; }
    ul[data-type="taskList"] > li { display: flex; align-items: flex-start; gap: 0.5em; margin: 0.2em 0; }
    ul[data-type="taskList"] > li > label { display: flex; align-items: center; padding-top: 0.2em; flex-shrink: 0; }
    ul[data-type="taskList"] > li > label > span { display: none; }
    ul[data-type="taskList"] > li > div { flex: 1; }
    ul[data-type="taskList"] > li > div > p { margin: 0; }
    ul[data-type="taskList"] > li[data-checked="true"] > div { text-decoration: line-through; color: #71717a; }${TABLE_CSS}
    @media (prefers-color-scheme: dark) {
        body { color: #e5e5e5; background: #18181b; }
        pre, code { background: #27272a; }
        blockquote { border-color: #3f3f46; color: #a1a1aa; }
        a.file-attachment { background: #27272a; }
        ul[data-type="taskList"] > li[data-checked="true"] > div { color: #71717a; }${TABLE_CSS_DARK}
    }`;

/** A standalone `.html` page for one note. */
function buildNotePage(title: string, bodyHtml: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'none';">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`;
}

/** A self-contained browser: the tree sidebar on the left, the content pane on the right. All inline (it works over file://). */
function buildViewerHtml(tree: TreeNode[]): string {
    const treeJson = JSON.stringify(tree).replace(/</g, "\\u003c");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>ZKnotes export</title>
<style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        display: flex; height: 100vh; color: #1a1a1a; background: #fff; }
    #sidebar { width: 300px; min-width: 0; flex-shrink: 0; border-right: none; overflow: auto;
        padding: 1rem; background: #fafafa; }
    #divider { width: 5px; flex-shrink: 0; cursor: col-resize; background: #e4e4e7;
        transition: background 0.15s; }
    #divider:hover, #divider.dragging { background: #a1a1aa; }
    #sidebar h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em;
        color: #71717a; margin: 0 0 0.75rem; }
    #main { flex: 1; overflow: auto; padding: 2rem 2.5rem; }
    .note-body { max-width: 760px; line-height: 1.6; }
    ul { list-style: none; margin: 0; padding-left: 0.85rem; }
    #tree { padding-left: 0; }
    .row { padding: 0.2rem 0.4rem; border-radius: 6px; cursor: pointer; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; font-size: 0.9rem; }
    .row:hover { background: #efeff1; }
    .row.active { background: #dbeafe; color: #1e40af; }
    li.collapsed > ul { display: none; }
    img { max-width: 100%; height: auto; border-radius: 6px; }
    pre { background: #f4f4f5; padding: 1rem; border-radius: 8px; overflow: auto; }
    code { background: #f4f4f5; padding: 0.1em 0.3em; border-radius: 4px; }
    blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 1rem; color: #555; }
    a { color: #2563eb; }
    a.file-attachment { display: inline-flex; align-items: center; gap: 0.3em; padding: 0.2em 0.5em;
        background: #f4f4f5; border-radius: 4px; text-decoration: none; font-size: 0.9em; }
    a.file-attachment::before { content: "📎"; }
    ul[data-type="taskList"] { list-style: none; padding-left: 0; }
    ul[data-type="taskList"] > li { display: flex; align-items: flex-start; gap: 0.5em; margin: 0.2em 0; }
    ul[data-type="taskList"] > li > label { display: flex; align-items: center; padding-top: 0.2em; flex-shrink: 0; }
    ul[data-type="taskList"] > li > label > span { display: none; }
    ul[data-type="taskList"] > li > div { flex: 1; }
    ul[data-type="taskList"] > li > div > p { margin: 0; }
    ul[data-type="taskList"] > li[data-checked="true"] > div { text-decoration: line-through; color: #71717a; }${TABLE_CSS}
    @media (prefers-color-scheme: dark) {
        body { color: #e5e5e5; background: #18181b; }
        #sidebar { background: #1f1f23; }
        #divider { background: #3f3f46; }
        #divider:hover, #divider.dragging { background: #71717a; }
        .row:hover { background: #27272a; }
        .row.active { background: #1e3a8a; color: #bfdbfe; }
        pre, code { background: #27272a; }
        blockquote { border-color: #3f3f46; color: #a1a1aa; }
        a.file-attachment { background: #27272a; }
        ul[data-type="taskList"] > li[data-checked="true"] > div { color: #71717a; }${TABLE_CSS_DARK}
    }
</style>
</head>
<body>
<nav id="sidebar"><h2>Notes</h2><ul id="tree"></ul></nav>
<div id="divider"></div>
<main id="main"><div class="note-body" id="content"><p style="color:#71717a">Select a note from the sidebar.</p></div></main>
<script>
const TREE = ${treeJson};
const byId = {};
TREE.forEach(function (n) { byId[n.id] = n; n.children = []; });
const roots = [];
TREE.forEach(function (n) {
    if (n.parentId && byId[n.parentId]) byId[n.parentId].children.push(n);
    else roots.push(n);
});
function cmp(a, b) {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return String(a.sortOrder || "").localeCompare(String(b.sortOrder || ""));
}
function render(nodes, ul) {
    nodes.slice().sort(cmp).forEach(function (n) {
        const li = document.createElement("li");
        const row = document.createElement("div");
        row.className = "row " + n.type;
        row.dataset.id = n.id;
        row.textContent = (n.type === "folder" ? "\\uD83D\\uDCC1 " : "\\uD83D\\uDCC4 ") + n.title;
        li.appendChild(row);
        if (n.type === "folder") {
            const child = document.createElement("ul");
            render(n.children, child);
            li.appendChild(child);
            row.addEventListener("click", function () { li.classList.toggle("collapsed"); });
        } else {
            row.addEventListener("click", function () { open(n); });
        }
        ul.appendChild(li);
    });
}
function open(n) {
    document.querySelectorAll(".row.active").forEach(function (e) { e.classList.remove("active"); });
    const row = document.querySelector('.row[data-id="' + n.id + '"]');
    if (row) row.classList.add("active");
    document.getElementById("content").innerHTML = "<h1>" + n.titleHtml + "</h1>" + (n.html || "");
}
TREE.forEach(function (n) {
    const d = document.createElement("div");
    d.textContent = n.title;
    n.titleHtml = d.innerHTML;
});
render(roots, document.getElementById("tree"));
const first = TREE.find(function (n) { return n.type === "note"; });
if (first) open(first);
// Mention links (data-note-id) open the note inside the browser.
document.getElementById("content").addEventListener("click", function (e) {
    const a = e.target.closest("a[data-note-id]");
    if (!a) return;
    e.preventDefault();
    const note = byId[a.getAttribute("data-note-id")];
    if (note && note.type === "note") open(note);
});
// The splitter: drag #divider to change the sidebar's width.
(function () {
    const divider = document.getElementById("divider");
    const sidebar = document.getElementById("sidebar");
    let dragging = false, startX = 0, startW = 0;
    divider.addEventListener("mousedown", function (e) {
        dragging = true;
        startX = e.clientX;
        startW = sidebar.getBoundingClientRect().width;
        divider.classList.add("dragging");
        document.body.style.cssText += ";cursor:col-resize;user-select:none;";
        e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        const w = Math.max(120, Math.min(600, startW + e.clientX - startX));
        sidebar.style.width = w + "px";
    });
    document.addEventListener("mouseup", function () {
        if (!dragging) return;
        dragging = false;
        divider.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    });
}());
</script>
</body>
</html>`;
}

export async function exportHtml(options: HtmlExportOptions = {}): Promise<ExportResult> {
    const { includeFiles = true, onProgress } = options;
    const date = new Date().toISOString().slice(0, 10);

    // Open the sink while the user gesture (the transient activation) for showSaveFilePicker still holds.
    const sink: BackupSink =
        options.sink ??
        (await createBackupSink(`zknotes-notes-${date}.zip`, "application/zip", {
            "application/zip": [".zip"],
        }));

    const live = await loadLiveItems();
    const noteItems = live.filter((i) => i.type === "note");
    const folderItems = live.filter((i) => i.type === "folder");
    const fileItems = live.filter((i) => i.type === "file");

    // Path metadata: folders need decrypted titles for the directory names and the sidebar.
    const metaById = new Map<string, PathMeta>();
    for (const item of live) {
        metaById.set(item.id, { parent_id: item.parent_id, title: "Untitled", type: item.type });
    }
    const folderTitleById = new Map<string, string>();
    for (const folder of folderItems) {
        try {
            const payload = await decryptItemPayload<{ title?: string }>(folder);
            const title = payload.title || "Untitled";
            // biome-ignore lint/style/noNonNullAssertion: metaById contains every live item
            metaById.get(folder.id)!.title = title;
            folderTitleById.set(folder.id, title);
        } catch (e) {
            console.warn(`HTML export: skipping folder title ${folder.id}`, e);
        }
    }

    // The file names (a cheap payload decrypt, no chunks) for the image rewrite and the attachment paths.
    const fileNameById = new Map<string, string>();
    for (const file of fileItems) {
        try {
            const payload = await decryptItemPayload<FilePayload>(file);
            fileNameById.set(file.id, safeName(payload.name || file.id));
        } catch (e) {
            console.warn(`HTML export: skipping file name ${file.id}`, e);
        }
    }

    const zw = new ZipStreamWriter(sink);
    const total = noteItems.length + fileItems.length;
    const run = new ExportRun<HtmlExportProgress>(total, onProgress);

    try {
        // ── Pass 1: decrypt every note and collect the paths for the mention rewrite ─────────────
        // Mention links (`/note/<id>`) have to be rewritten into relative paths, and for that
        // EVERY note's path has to be known before we write a single one. So we decrypt into memory
        // first, and only then write the ZIP.
        const notes: NoteEntry[] = [];
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
                const depth = folder ? folder.split("/").length : 0;
                let path = folder ? `${folder}/${safeName(title)}.html` : `${safeName(title)}.html`;
                // Deduplicate name collisions within the same folder (otherwise a silent overwrite).
                if (usedPaths.has(path)) {
                    let n = 2;
                    const base = path.slice(0, -".html".length);
                    while (usedPaths.has(`${base} (${n}).html`)) n++;
                    path = `${base} (${n}).html`;
                }
                usedPaths.add(path);

                notes.push({
                    id: item.id,
                    type: "note",
                    parentId: item.parent_id,
                    sortOrder: item.sort_order,
                    title,
                    content,
                    folder,
                    path,
                    depth,
                });
            } catch (e) {
                run.skip(item, e, "HTML export");
            }
            run.done++;
            run.emit("notes");
        }

        // A map of noteId → the .html file's path inside the ZIP (for the mention rewrite in standalone mode).
        const notePathById = new Map<string, string>(notes.map((n) => [n.id, n.path]));

        // ── Pass 2: generate the HTML and write it into the ZIP ──────────────────────────────────
        const tree: TreeNode[] = folderItems.map((f) => ({
            id: f.id,
            type: "folder" as const,
            title: folderTitleById.get(f.id) || "Untitled",
            parentId: f.parent_id,
            sortOrder: f.sort_order,
        }));

        for (const note of notes) {
            const cleanContent = sanitizeHtml(note.content);
            tree.push({
                id: note.id,
                type: "note",
                title: note.title,
                parentId: note.parentId,
                sortOrder: note.sortOrder,
                // Viewer: prefix="" (root-relative paths), without notePathById (the viewer JS mode).
                html: rewriteContent(cleanContent, "", fileNameById, undefined),
            });

            const standalonePrefix = "../".repeat(note.depth);
            const body = rewriteContent(cleanContent, standalonePrefix, fileNameById, notePathById);
            await zw.addFile(note.path, strToU8(buildNotePage(note.title, body)), true);
        }

        // ── Attachments: the referenced inline images always; standalone files only with includeFiles ──
        const filesToWrite = fileItems.filter((f) => referencedFileIds.has(f.id) || includeFiles);
        // The counter for the remaining (excluded) items is skipped so the total stays accurate.
        run.done += fileItems.length - filesToWrite.length;

        const { decryptFile } = await import("$lib/modules/files/download");
        await run.stage("files", filesToWrite, "HTML export", async (item) => {
            // The same one-shot read as the full backup: fetch what this device never
            // downloaded, and leave the offline cache alone.
            const result = await decryptFile(item.id, undefined, {
                forceDownload: true,
                persist: false,
            });
            const name = fileNameById.get(item.id) || safeName(result.name || item.id);
            await zw.addFile(`_attachments/${item.id}/${name}`, result.bytes, false);
        });

        // ── the index.html browser + finalise ────────────────────────────────
        run.emit("zipping");
        await zw.addFile("index.html", strToU8(buildViewerHtml(tree)), true);
        await zw.finish();
        await sink.close();
    } catch (e) {
        await sink.abort(e).catch(() => {});
        throw e;
    }
    return { skipped: run.skipped };
}
