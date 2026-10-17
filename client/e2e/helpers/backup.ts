import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
    type Browser,
    type BrowserContext,
    type Download,
    expect,
    type Locator,
    type Page,
} from "@playwright/test";
import {
    breadcrumbRenameInput,
    createNoteAndNavigate,
    E2E_API_URL,
    loginUser,
    waitForVaultUnlocked,
} from "./auth";
import {
    captureEmbedFileId,
    fileCard,
    openFileDetailPanel,
    redPngBuffer,
    uploadToNote,
} from "./files";
/**
 * Creates a folder through the sidebar button and commits the inline rename.
 * It deliberately does NOT use `helpers/folder-helper.createFolder`: its `getByRole("textbox")`
 * also catches the ProseMirror while the editor is open (a strict-mode failure, or the rename going
 * into the editor).
 */
export async function createNamedFolder(page: Page, name: string): Promise<Locator> {
    await page.getByTitle("New folder", { exact: true }).click();
    const input = page.locator('[data-testid="folder-tree"] input[type="text"]');
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill(name);
    await input.press("Enter");
    const row = treeFolder(page, name);
    await expect(row).toBeVisible({ timeout: 10_000 });
    return row;
}

/** One place of truth for the passphrase in this spec — `restoreBackup` has no such argument. */
export const E2E_BACKUP_PASSPHRASE = "e2e-backup-pass-92";

export const REF = {
    folderA: "Folder A",
    folderAB: "Folder A/B",
    folderC: "Folder C",
    noteA1: "Note A-1",
    noteA2: "Note A-2",
    noteAB1: "Note A-B-1",
    noteRoot: "Note ROOT-1",
    attachName: "note-a1-attachment.txt",
    imageName: "note-a2-inline.png",
} as const;

const ATTACH_BYTES = Buffer.from("e2e-a1-attachment-bytes\n");
const IMAGE_BYTES = redPngBuffer();

export type TreeSnap = {
    id: string;
    title: string;
    parentId: string | null;
    indexWithinParent: number;
};

export type FileSnap = {
    id: string;
    name: string;
    size: number;
    sha256: string;
};

export type StorageSnap = {
    items_bytes: number;
    files_bytes: number;
    history_bytes: number;
    trashed_bytes: number;
};

export type WorkspaceSnapshot = {
    tree: TreeSnap[];
    files: FileSnap[];
    storage: StorageSnap;
};

export type ReferenceWorkspace = {
    notes: Record<"a1" | "a2" | "ab1" | "root", { id: string; title: string }>;
    folders: Record<"a" | "ab" | "c", { id: string; title: string }>;
};

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256Hex(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
}

function treeRow(page: Page, type: "note" | "folder", title: string): Locator {
    return page
        .locator(`[data-node-type="${type}"]`)
        .filter({
            has: page.locator("span.truncate", { hasText: new RegExp(`^${escapeRe(title)}$`) }),
        })
        .first();
}

export function treeNote(page: Page, title: string): Locator {
    return treeRow(page, "note", title);
}

export function treeFolder(page: Page, title: string): Locator {
    return treeRow(page, "folder", title);
}

/**
 * Waits for an idle sync **positively**. A negative check ("not pending") is green on Offline
 * and Sync issue too — exactly where the push did not go through.
 */
export async function waitForSyncIdle(page: Page, timeout = 90_000): Promise<void> {
    await expect(page.getByTestId("sync-status").locator("span.truncate")).toHaveText(
        /^(All changes saved|Synced )/,
        { timeout },
    );
}

export async function fetchStorage(page: Page): Promise<StorageSnap> {
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "session_token");
    if (!session) throw new Error("session_token cookie missing — cannot read /me/storage");
    // Node resolves `localhost` to ::1 while the API listens on IPv4 — hence 127.0.0.1 plus a manual cookie.
    const origin = E2E_API_URL.replace("localhost", "127.0.0.1");
    const res = await page.request.get(`${origin}/me/storage`, {
        headers: { Cookie: `session_token=${session.value}` },
        timeout: 15_000,
    });
    if (!res.ok()) {
        throw new Error(`GET /me/storage failed: ${res.status()} ${await res.text()}`);
    }
    const body = (await res.json()) as { breakdown: StorageSnap };
    return body.breakdown;
}

async function expandAllFolders(page: Page): Promise<void> {
    for (let i = 0; i < 12; i++) {
        const closed = page.locator('[data-node-type="folder"] .caret:not(.open)');
        if ((await closed.count()) === 0) return;
        await closed.first().click();
    }
}

async function expandFolder(page: Page, title: string): Promise<void> {
    const row = treeFolder(page, title);
    await expect(row).toBeVisible({ timeout: 10_000 });
    const caret = row.locator(".caret");
    const open = await caret.evaluate((el) => el.classList.contains("open"));
    if (!open) await caret.click();
}

async function saveEditor(page: Page): Promise<void> {
    await page.keyboard.press("Control+s");
    await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });
}

async function createNamedNote(page: Page, title: string): Promise<string> {
    const url = await createNoteAndNavigate(page);
    const input = breadcrumbRenameInput(page);
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill(title);
    await input.press("Enter");
    await expect(treeNote(page, title)).toBeVisible({ timeout: 10_000 });
    const id = new URL(url).pathname.split("/note/")[1];
    if (!id) throw new Error(`note id missing from ${url}`);
    return id;
}

/**
 * Moving a note into a folder by drag and drop. `dragTo` targets the middle of the row (the "inside"
 * zone, 25–75 %). If Chromium swallows the DataTransfer, it falls back to a manual HTML5 drop with
 * `text/plain`.
 */
export async function moveNoteIntoFolder(
    page: Page,
    noteTitle: string,
    folderTitle: string,
): Promise<void> {
    const note = treeNote(page, noteTitle);
    const folder = treeFolder(page, folderTitle);
    await expect(note).toBeVisible({ timeout: 10_000 });
    await expect(folder).toBeVisible({ timeout: 10_000 });
    const noteId = await note.getAttribute("data-node-id");
    const folderId = await folder.getAttribute("data-node-id");
    if (!noteId || !folderId) throw new Error("missing data-node-id on drag source/target");

    const box = await folder.boundingBox();
    await note.dragTo(folder, {
        targetPosition: {
            x: Math.max(24, (box?.width ?? 80) / 2),
            y: Math.max(8, (box?.height ?? 22) / 2),
        },
    });

    const moved = await waitForParent(page, noteId, folderId, 5_000);
    if (moved) return;

    await page.evaluate(
        ({ sourceId, targetId }) => {
            const src = document.querySelector(`[data-node-id="${sourceId}"]`);
            const dst = document.querySelector(`[data-node-id="${targetId}"]`);
            if (!(src instanceof HTMLElement) || !(dst instanceof HTMLElement)) {
                throw new Error("drag nodes missing");
            }
            const dt = new DataTransfer();
            dt.setData("text/plain", sourceId);
            dt.setData("application/x-note-id", sourceId);
            dt.effectAllowed = "move";
            src.dispatchEvent(
                new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }),
            );
            const rect = dst.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            dst.dispatchEvent(
                new DragEvent("dragover", {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer: dt,
                    clientX: cx,
                    clientY: cy,
                }),
            );
            dst.dispatchEvent(
                new DragEvent("drop", {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer: dt,
                    clientX: cx,
                    clientY: cy,
                }),
            );
        },
        { sourceId: noteId, targetId: folderId },
    );

    const ok = await waitForParent(page, noteId, folderId, 10_000);
    if (!ok) {
        throw new Error(`failed to move "${noteTitle}" into "${folderTitle}"`);
    }
}

async function waitForParent(
    page: Page,
    noteId: string,
    folderId: string,
    timeout: number,
): Promise<boolean> {
    try {
        await expect.poll(async () => parentIdFromDom(page, noteId), { timeout }).toBe(folderId);
        return true;
    } catch {
        return false;
    }
}

async function parentIdFromDom(page: Page, id: string): Promise<string | null> {
    return page.evaluate((nodeId) => {
        const row = document.querySelector(`[data-node-id="${nodeId}"]`);
        if (!(row instanceof HTMLElement)) return null;
        const wrap = row.parentElement;
        const parentWrap = wrap?.parentElement?.closest(".flex.flex-col");
        const parentRow = parentWrap?.querySelector(":scope > [data-node-id]");
        return parentRow instanceof HTMLElement ? (parentRow.dataset.nodeId ?? null) : null;
    }, id);
}

/**
 * The tree read out of the DOM after an expand-all. The children's order = the visual order =
 * sort_order within the parent.
 */
export async function snapshotTree(page: Page): Promise<TreeSnap[]> {
    await page.goto("/");
    await waitForVaultUnlocked(page);
    await expect(page.locator('[data-testid="folder-tree"] [data-node-id]').first()).toBeVisible({
        timeout: 15_000,
    });
    await expect
        .poll(
            async () => {
                await expandAllFolders(page);
                return page.locator('[data-node-type="folder"] .caret:not(.open)').count();
            },
            { timeout: 15_000 },
        )
        .toBe(0);
    return page.evaluate(() => {
        const root = document.querySelector('[data-testid="folder-tree"] .w-full');
        if (!root) return [];
        const result: Array<{ id: string; title: string; parentId: string | null }> = [];
        const walk = (container: Element, parentId: string | null) => {
            for (const wrap of Array.from(container.children)) {
                const row = wrap.querySelector(":scope > [data-node-id]");
                if (!(row instanceof HTMLElement)) continue;
                const id = row.dataset.nodeId;
                if (!id) continue;
                const title = row.querySelector("span.truncate")?.textContent?.trim() ?? "";
                result.push({ id, title, parentId });
                const childBox = Array.from(wrap.children).find((c) => c !== row);
                if (childBox) walk(childBox, id);
            }
        };
        walk(root, null);
        const counts = new Map<string, number>();
        return result.map((item) => {
            const key = item.parentId ?? "";
            const idx = counts.get(key) ?? 0;
            counts.set(key, idx + 1);
            return { ...item, indexWithinParent: idx };
        });
    });
}

/**
 * A snapshot of the current UI + the server-side quotas. The file bytes are fetched through "Save a copy"
 * (on the client that did the import that is the local cache — which is why the attachment test downloads in
 * a cold context).
 */
export async function snapshotWorkspace(page: Page): Promise<WorkspaceSnapshot> {
    const tree = await snapshotTree(page);

    const files: FileSnap[] = [];
    for (const item of tree.filter((t) => t.title === REF.noteA1 || t.title === REF.noteA2)) {
        await page.goto(`/note/${item.id}`);
        await waitForVaultUnlocked(page);
        const node = page.locator(".encfile-node[data-file-id]").first();
        if ((await node.count()) === 0) continue;
        const fileId = await captureEmbedFileId(page);
        const name = item.title === REF.noteA1 ? REF.attachName : REF.imageName;
        await page.goto("/files");
        await expect(fileCard(page, name)).toBeVisible({ timeout: 30_000 });
        await openFileDetailPanel(page, name);
        const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 30_000 }),
            page.getByRole("button", { name: "Save a copy" }).click(),
        ]);
        const path = await download.path();
        if (!path) throw new Error(`download path empty for ${name}`);
        const buf = await readFile(path);
        files.push({ id: fileId, name, size: buf.byteLength, sha256: sha256Hex(buf) });
    }

    const storage = await fetchStorage(page);
    return { tree, files, storage };
}

/**
 * Builds the reference workspace. The notes BEFORE the folders, then dragged inside. Folder C stays
 * empty.
 */
export async function buildReferenceWorkspace(page: Page): Promise<ReferenceWorkspace> {
    const idA1 = await createNamedNote(page, REF.noteA1);
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await editor.click();
    await editor.fill("content A-1");
    await uploadToNote(page, REF.attachName, "text/plain", ATTACH_BYTES);
    await captureEmbedFileId(page);
    await saveEditor(page);

    const idA2 = await createNamedNote(page, REF.noteA2);
    await editor.click();
    await editor.fill("content A-2");
    await uploadToNote(page, REF.imageName, "image/png", IMAGE_BYTES);
    await captureEmbedFileId(page);
    await saveEditor(page);

    const idAB1 = await createNamedNote(page, REF.noteAB1);
    await editor.click();
    await editor.fill("content A-B-1");
    await saveEditor(page);

    const idRoot = await createNamedNote(page, REF.noteRoot);
    await editor.click();
    await editor.fill("content ROOT-1");
    await saveEditor(page);

    // Folder A as a sibling of the open root note (parent = null).
    await createNamedFolder(page, REF.folderA);
    const folderAId = await treeFolder(page, REF.folderA).getAttribute("data-node-id");
    if (!folderAId) throw new Error("Folder A id missing");

    await treeFolder(page, REF.folderA).click();
    await createNamedFolder(page, REF.folderAB);
    const folderABId = await treeFolder(page, REF.folderAB).getAttribute("data-node-id");
    if (!folderABId) throw new Error("Folder A/B id missing");

    await treeNote(page, REF.noteRoot).click();
    await createNamedFolder(page, REF.folderC);
    const folderCId = await treeFolder(page, REF.folderC).getAttribute("data-node-id");
    if (!folderCId) throw new Error("Folder C id missing");

    await expandFolder(page, REF.folderA);
    await moveNoteIntoFolder(page, REF.noteA1, REF.folderA);
    await moveNoteIntoFolder(page, REF.noteA2, REF.folderA);
    await expandFolder(page, REF.folderAB);
    await moveNoteIntoFolder(page, REF.noteAB1, REF.folderAB);

    return {
        notes: {
            a1: { id: idA1, title: REF.noteA1 },
            a2: { id: idA2, title: REF.noteA2 },
            ab1: { id: idAB1, title: REF.noteAB1 },
            root: { id: idRoot, title: REF.noteRoot },
        },
        folders: {
            a: { id: folderAId, title: REF.folderA },
            ab: { id: folderABId, title: REF.folderAB },
            c: { id: folderCId, title: REF.folderC },
        },
    };
}

export async function exportEncryptedBackup(
    page: Page,
    passphrase: string = E2E_BACKUP_PASSPHRASE,
): Promise<string> {
    await page.addInitScript(() => {
        delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await page.goto("/settings");
    await page.getByRole("link", { name: "Backup" }).click();
    await expect(page.locator("h1", { hasText: "Backup" })).toBeVisible();

    await page.getByRole("button", { name: "Create Encrypted Backup" }).click();
    await page.getByPlaceholder("Backup passphrase").fill(passphrase);
    await page.getByPlaceholder("Confirm passphrase").fill(passphrase);

    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "Create encrypted backup" }).click();
    await continuePastDownloadNotice(page, downloadPromise, "Download and back up");
    const download = await downloadPromise;
    const path = await download.path();
    if (!path) throw new Error("encrypted backup download path is empty");
    return path;
}

/**
 * When attachments are not all on this device, a backup or an export first shows how much
 * it will download, and the save starts only after the user continues. A file uploaded from this
 * device counts too until it has been viewed — an upload does not fill the chunk cache.
 */
export async function continuePastDownloadNotice(
    page: Page,
    download: Promise<Download>,
    continueLabel: string,
): Promise<void> {
    const notice = page.getByTestId("export-download-notice");
    const first = await Promise.race([
        download.then(
            () => "download" as const,
            () => "download" as const,
        ),
        notice.waitFor({ state: "visible", timeout: 60_000 }).then(
            () => "notice" as const,
            () => "none" as const,
        ),
    ]);
    if (first === "notice") await notice.getByRole("button", { name: continueLabel }).click();
}

/**
 * The only entry point for a restore in this spec. When the restore flow changes, the BODY is
 * rewritten, not the signature.
 */
export async function restoreBackup(
    page: Page,
    file: string,
    mode: "overwrite" | "skip",
): Promise<void> {
    await page.goto("/settings");
    await page.getByRole("link", { name: "Backup" }).click();
    await expect(page.locator("h1", { hasText: "Backup" })).toBeVisible();

    await page.locator('input[type="file"][accept*="cnbackup"]').setInputFiles(file);
    await page.getByPlaceholder("Backup passphrase").fill(E2E_BACKUP_PASSPHRASE);
    await page.getByRole("button", { name: "Unlock" }).click();

    const modeLabel = mode === "overwrite" ? "Overwrite all" : "Skip existing";
    await page.getByText(modeLabel, { exact: false }).click();
    await page.getByRole("button", { name: "Start restore" }).click();
    await page.getByRole("button", { name: "Confirm restore" }).click();

    await expect(page.getByTestId("restore-complete")).toBeVisible({ timeout: 120_000 });
}

export async function openColdContext(
    browser: Browser,
    email: string,
    password: string,
): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext();
    await context.addInitScript(() => {
        delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const page = await context.newPage();
    await loginUser(page, email, password);
    await waitForVaultUnlocked(page);
    return { context, page };
}

export async function trashItemByTitle(
    page: Page,
    type: "note" | "folder",
    title: string,
): Promise<void> {
    const row = treeRow(page, type, title);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click({ button: "right" });
    await page.locator(".ctx-menu").getByText("Move to trash").click();
    await expect(row).toBeHidden({ timeout: 10_000 });
}

export async function emptyTrash(page: Page): Promise<void> {
    await page.goto("/trash");
    const emptyBtn = page.getByRole("button", { name: /Empty trash/i });
    await expect(emptyBtn).toBeVisible({ timeout: 15_000 });
    await emptyBtn.click();
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /Empty trash/i })
        .click();
}

export async function deleteForeverFromTrash(page: Page, title: string): Promise<void> {
    await page.goto("/trash");
    const row = page.getByRole("main").locator(".group", { hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: /Delete forever/i }).click();
    await page
        .getByRole("dialog")
        .getByRole("button", { name: /Delete forever/i })
        .click();
    await expect(row).toBeHidden({ timeout: 15_000 });
}

export function orderIds(tree: TreeSnap[], parentId: string | null): string[] {
    return tree
        .filter((t) => t.parentId === parentId)
        .sort((a, b) => a.indexWithinParent - b.indexWithinParent)
        .map((t) => t.id);
}
