import { expect, type Locator, type Page } from "@playwright/test";
import { createNoteAndNavigate } from "./auth";

/**
 * Shared helpers for the file-lifecycle E2E (one place of truth — see
 * the strict 1:1 model: every blob belongs to exactly one item).
 *
 * The selectors are taken from the code (confirmed by reading it):
 *   - /files:               src/routes/(app)/files/+page.svelte
 *   - FileDetailPanel:      src/lib/modules/files/FileDetailPanel.svelte
 *   - CropModal:            src/lib/modules/files/CropModal.svelte
 *   - note editor:          src/routes/(app)/note/[id]/+page.svelte
 *   - Toast (Undo):         src/lib/core/ui/Toast.svelte (action.label → button text)
 *
 * No `data-testid` (the existing specs do not use one).
 */

/** Long timeouts — a real chunked crypto upload is slow (see the existing 03/04). */
export const UPLOAD_TIMEOUT = 30_000;
/** Embed invalidation/rename under the full parallel suite (crypto worker contention). */
export const EMBED_SETTLE_TIMEOUT = 60_000;
/** Trash and restore are local-first — they settle without the network, so a shorter timeout. */
export const LIFECYCLE_TIMEOUT = 15_000;

/**
 * A valid 64×64 red PNG image (RGB). A real image (not a 1×1) so the CropModal canvas
 * has something to render and that a crop gives a meaningful result.
 */
const RED_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAg0lEQVR4nO3RQQkAMAwEwSiJfymVVRF9DIWFE5DMztn9esMv6AFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWAFNWIH1ii+7yqdA8YvQ6X0AAAAASUVORK5CYII=";

/** Returns a fresh buffer holding a red PNG image (64×64). */
export function redPngBuffer(): Buffer {
    return Buffer.from(RED_PNG_B64, "base64");
}

/** A file row/card in /files (list or grid) — `role=button` + `.group`, not a pending-upload row. */
export function fileCard(page: Page, name: string) {
    return page.getByRole("main").locator('[role="button"].group', { hasText: name }).first();
}

/**
 * Upload a NON-image document through the note editor → it appears in the /files list.
 * /files no longer has an Upload button of its own (it was removed with the unified trash).
 */
export async function uploadDocToFiles(
    page: Page,
    name: string,
    mimeType = "text/plain",
    buffer: Buffer = Buffer.from(`e2e file content ${Date.now()}`),
): Promise<void> {
    await page.goto("/");
    await createNoteAndNavigate(page);
    await uploadToNote(page, name, mimeType, buffer);
    await captureEmbedFileId(page);
    await page.goto("/files");
    await expect(fileCard(page, name)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
}

/**
 * Uploads an image through the note editor → CropModal.
 */
export async function uploadImageToFiles(
    page: Page,
    name: string,
    action: "crop" | "skip",
    buffer: Buffer = redPngBuffer(),
): Promise<void> {
    await page.goto("/");
    await createNoteAndNavigate(page);
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: UPLOAD_TIMEOUT });
    await editor.click();
    await page
        .locator(".editor-toolbar input[type='file']")
        .setInputFiles({ name, mimeType: "image/png", buffer });

    const cropBtn = page.getByRole("button", { name: /Crop & upload/ });
    const uploadBtn = page.getByRole("button", { name: "Upload", exact: true });
    const embed = page.locator(".encfile-node", { hasText: name });

    // A small image (≤10 MB) takes the silent path with no modal; a large one needs a confirm dialog.
    // The CropModal is no longer used on upload — a crop is an action on an existing image in the
    // panel.
    const path = await Promise.race([
        cropBtn.waitFor({ state: "visible", timeout: 4000 }).then(() => "crop" as const),
        uploadBtn.waitFor({ state: "visible", timeout: 4000 }).then(() => "confirm" as const),
        embed.waitFor({ state: "visible", timeout: UPLOAD_TIMEOUT }).then(() => "silent" as const),
    ]).catch(async () => {
        await embed.waitFor({ state: "visible", timeout: UPLOAD_TIMEOUT });
        return "silent" as const;
    });

    if (path === "crop") {
        if (action === "crop") await cropBtn.click();
        else await page.getByRole("button", { name: /Skip \(use original\)/ }).click();
        await expect(cropBtn).toBeHidden({ timeout: UPLOAD_TIMEOUT });
    } else if (path === "confirm") {
        await uploadBtn.click();
    }

    await expect(embed).toBeVisible({ timeout: UPLOAD_TIMEOUT });
    await captureEmbedFileId(page);
    await page.goto("/files");
    await expect(fileCard(page, name)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
}

/**
 * Uploads an attachment from the note editor (the hidden input + the "Upload" confirm dialog).
 * Waits for the embed (`.encfile-node`) to appear. A mirror of 04-files-in-notes.spec.ts.
 * It assumes we are already on a /note/:id page with the editor focused.
 */
export async function uploadToNote(
    page: Page,
    name: string,
    mimeType: string,
    buffer: Buffer,
): Promise<void> {
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: UPLOAD_TIMEOUT });
    await editor.click();
    await page
        .locator(".editor-toolbar + input[type='file']")
        .setInputFiles({ name, mimeType, buffer });

    const uploadBtn = page.getByRole("button", { name: "Upload", exact: true });
    const embed = page.locator(".encfile-node", { hasText: name });
    const needsConfirm = await uploadBtn
        .waitFor({ state: "visible", timeout: 4000 })
        .then(() => true)
        .catch(() => false);
    if (needsConfirm) await uploadBtn.click();

    // Images render an <img> with no visible name in innerText — an encFile node or the attachment strip is enough.
    if (mimeType.startsWith("image/")) {
        await expect(page.locator(".encfile-node[data-file-id]").first()).toBeVisible({
            timeout: UPLOAD_TIMEOUT,
        });
    } else {
        await expect(embed).toBeVisible({ timeout: UPLOAD_TIMEOUT });
    }
}

/**
 * Opens /files for operations on the attachments (the NoteAttachments strip is gone).
 * Before calling it, make sure the upload finished in the editor (an `.encfile-node` with a name) —
 * otherwise the navigation can persist a `local:` ref and the embed disappears later.
 */
export async function openFilesTabInNote(page: Page): Promise<void> {
    await page.goto("/files");
}

/**
 * Go back to the note editor (an explicit navigation — more dependable than goBack after /files).
 */
export async function openEditorTabInNote(page: Page, noteUrl: string): Promise<void> {
    await page.goto(noteUrl);
    const historyDrawer = page
        .locator("div.fixed.inset-y-0.right-0")
        .filter({ hasText: "Version History" });
    if (await historyDrawer.isVisible()) {
        await page.locator('[role="presentation"].fixed').click({ position: { x: 50, y: 50 } });
        await historyDrawer.waitFor({ state: "hidden", timeout: 5_000 });
    }
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible({
        timeout: 15_000,
    });
}

/**
 * FileDetailPanel is an `<aside>` — but the app sidebar is ALSO an `<aside>`, so we scope to the panel
 * through the "Replace content" button that is unique to it.
 */
export function filePanel(page: Page) {
    return page
        .locator("aside")
        .filter({ has: page.getByRole("button", { name: /Replace content/ }) });
}

/** FileDetailPanel → Move to trash (the toolbar button plus the dialog's confirmation). */
export async function moveToTrashFromFilePanel(page: Page): Promise<void> {
    await filePanel(page).getByRole("button", { name: "Move to trash", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
}

/** Open the FileDetailPanel by clicking a file card. It uses .first() because there can briefly be 2 elements. */
export async function openFileDetailPanel(page: Page, name: string): Promise<void> {
    const card = fileCard(page, name);
    await expect(card).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
    // List view: click the title, not the checkbox.
    await card.getByText(name, { exact: true }).click();
    await expect(filePanel(page)).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
}

/**
 * Closes the FileDetailPanel. The panel has a full-screen backdrop (z-40) that intercepts clicks on
 * the rest of the UI (the Editor tab, say) — it has to be closed before interacting outside the panel.
 * We click the backdrop in the top-left corner (the panel is the right-hand `<aside>`).
 */
export async function closeFilePanel(page: Page): Promise<void> {
    // The X button in the panel's header (the first button in the <aside>) calls onClose directly — more
    // dependable than the backdrop's geometry. force: the header has no animation, but this avoids any overlay timing.
    await filePanel(page).getByRole("button").first().click({ force: true });
    await expect(filePanel(page)).toBeHidden({ timeout: LIFECYCLE_TIMEOUT });
}

/** Remove the embed from the note editor (toolbar → Remove). */
export async function removeEmbedFromNote(page: Page, name: string): Promise<void> {
    const node = page.locator(".encfile-node", { hasText: name });
    await node.click();
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(node).toBeHidden({ timeout: LIFECYCLE_TIMEOUT });
}

/**
 * Trashes one file from /files through the bulk checkbox (the Active view).
 * It selects the first row, "Move to trash (1)", and confirms "Move to trash" in the dialog.
 */
export async function trashFromFiles(page: Page): Promise<void> {
    await page.getByRole("checkbox").first().click();
    await page.getByRole("button", { name: /Move to trash \(1\)/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
}

/** Opens /files (the active READY files only). */
export async function showActive(page: Page): Promise<void> {
    await page.goto("/files");
}

/** Opens the unified /trash (notes, folders and individually deleted files). */
export async function showTrash(page: Page): Promise<void> {
    await page.goto("/trash");
}

/** The row in the /trash list (CollectionList) carrying the file's name. */
export function trashRow(page: Page, name: string) {
    return page.getByRole("main").locator(".group", { hasText: name }).first();
}

/** Restores one item from /trash (a CollectionListRow → the Restore button). */
export async function restoreFromTrash(page: Page, name: string): Promise<void> {
    await showTrash(page);
    const row = trashRow(page, name);
    await expect(row).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(row).toBeHidden({ timeout: LIFECYCLE_TIMEOUT });
}

/** An assertion: the file is in the Active grid / in the Trash list (the locally visible state). */
export async function expectInActive(page: Page, name: string): Promise<void> {
    await showActive(page);
    await expect(fileCard(page, name)).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
}
export async function expectInTrash(page: Page, name: string): Promise<void> {
    await showTrash(page);
    await expect(trashRow(page, name)).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
}

/** Capture an embed's `data-file-id` in the editor — a steadier proxy than hasText for a rename assertion. */
export async function captureEmbedFileId(page: Page): Promise<string> {
    const node = page.locator(".encfile-node[data-file-id]").first();
    await expect(node).toBeVisible({ timeout: UPLOAD_TIMEOUT });
    // A PDF or non-image upload holds a local: id briefly until the swap finishes.
    let id: string | null = null;
    await expect
        .poll(
            async () => {
                id = await node.getAttribute("data-file-id");
                return id && !id.startsWith("local:") ? id : null;
            },
            { timeout: UPLOAD_TIMEOUT },
        )
        .not.toBeNull();
    return id as string;
}

/** Proxy A: the rename is persisted in the /files list (a query refetch after emitFilesChanged). */
export async function expectFileRenamedInList(
    page: Page,
    original: string,
    renamed: string,
): Promise<void> {
    await expect(fileCard(page, renamed)).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
    await expect(fileCard(page, original)).toBeHidden({ timeout: LIFECYCLE_TIMEOUT });
}

/** Proxy B: the embed's chip and alt refreshed for the same file id (a decrypt plus a DOM update after returning to the editor). */
export async function expectEmbedRenamed(
    page: Page,
    fileId: string,
    renamed: string,
    original: string,
    scope?: Locator,
): Promise<void> {
    const root = scope ?? page;
    const node = root.locator(`.encfile-node[data-file-id="${fileId}"]`);
    await expect(node).toBeVisible({ timeout: UPLOAD_TIMEOUT });
    // resolveUrl → setNodeMarkup is async; under a parallel crypto-worker load in the full suite
    // a snapshot restore can hold the old alt for longer (see 07-history.spec.ts).
    await expect
        .poll(
            async () => {
                const text = await node.innerText();
                return text.includes(renamed) && !text.includes(original);
            },
            { timeout: EMBED_SETTLE_TIMEOUT },
        )
        .toBe(true);
}

/** The embed placeholder after a DB trash — it polls, so it works under the full parallel suite. */
export async function expectTrashedEmbed(page: Page, scope?: Locator): Promise<void> {
    const root = scope ?? page;
    const trashedEmbed = root.locator(".encfile-node", { hasText: "File in trash" });
    await expect
        .poll(async () => trashedEmbed.isVisible(), { timeout: EMBED_SETTLE_TIMEOUT })
        .toBe(true);
}
