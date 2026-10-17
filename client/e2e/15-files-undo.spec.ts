import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import {
    captureEmbedFileId,
    fileCard,
    LIFECYCLE_TIMEOUT,
    moveToTrashFromFilePanel,
    openFileDetailPanel,
    removeEmbedFromNote,
    restoreFromTrash,
    showActive,
    showTrash,
    trashRow,
    uploadDocToFiles,
    uploadToNote,
} from "./helpers/files";

/** The grace period plus a buffer — a check that the file did not go to Trash after a cancel. */
const TRASH_COMMIT_WAIT_MS = 6500;

/**
 * The unified trash model: a grace period in the editor, and an auto-restore on Ctrl+Z after the
 * commit. A delete from /files has no undo toast — a restore goes through /trash.
 */
test.describe("Files — undo mechanisms (editor vs toast)", () => {
    setupAuthenticatedUser();

    // These three were fixme'd as a Playwright limitation. The causes were in the app: the
    // editor's undo check read a history meta that never exists, the swap to the real file id was an
    // undo step, and a removal this soon after the insertion joined the insertion's undo step.
    test("Ctrl+Z within the grace period cancels the pending trash (the file stays Active)", async ({
        page,
    }) => {
        test.slow();
        const name = "undo-embed.pdf";

        await createNoteAndNavigate(page);
        await expect(page.locator('[data-node-type="note"]').first()).toBeVisible({
            timeout: LIFECYCLE_TIMEOUT,
        });
        await uploadToNote(page, name, "application/pdf", Buffer.from("editor undo pdf"));
        await expect(page.locator(".encfile-node", { hasText: name })).toBeVisible({
            timeout: 30_000,
        });
        await captureEmbedFileId(page);

        await removeEmbedFromNote(page, name);
        const undoBtn = page.getByRole("button", { name: "Undo", exact: true });
        await expect(undoBtn).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
        await undoBtn.click();

        const restoredEmbed = page.locator(".encfile-node", { hasText: name });
        await expect(restoredEmbed).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
        await expect(restoredEmbed).not.toContainText("File in trash");

        await page.waitForTimeout(TRASH_COMMIT_WAIT_MS);
        await showActive(page);
        await expect(fileCard(page, name)).toHaveCount(1, { timeout: LIFECYCLE_TIMEOUT });
        await showTrash(page);
        await expect(trashRow(page, name)).toHaveCount(0, { timeout: LIFECYCLE_TIMEOUT });
    });

    test("the toast's Undo within the grace period cancels the pending trash (the file stays Active)", async ({
        page,
    }) => {
        test.slow();
        const name = "undo-toast-grace.txt";

        await createNoteAndNavigate(page);
        await uploadToNote(page, name, "text/plain", Buffer.from("grace undo"));
        await expect(page.locator(".encfile-node", { hasText: name })).toBeVisible({
            timeout: 30_000,
        });

        await removeEmbedFromNote(page, name);
        const undoBtn = page.getByRole("button", { name: "Undo", exact: true });
        await expect(undoBtn).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
        await undoBtn.click();

        await expect(page.locator(".encfile-node", { hasText: name })).toBeVisible({
            timeout: LIFECYCLE_TIMEOUT,
        });
        await page.waitForTimeout(TRASH_COMMIT_WAIT_MS);
        await showActive(page);
        await expect(fileCard(page, name)).toHaveCount(1, { timeout: LIFECYCLE_TIMEOUT });
        await showTrash(page);
        await expect(trashRow(page, name)).toHaveCount(0, { timeout: LIFECYCLE_TIMEOUT });
    });

    test("Ctrl+Z after the grace commit auto-restores the TRASHED file", async ({ page }) => {
        test.slow();
        const name = "ctrlz-restore.txt";

        await createNoteAndNavigate(page);
        await uploadToNote(page, name, "text/plain", Buffer.from("ctrlz restore"));
        await expect(page.locator(".encfile-node", { hasText: name })).toBeVisible({
            timeout: 30_000,
        });

        await removeEmbedFromNote(page, name);
        await page.waitForTimeout(TRASH_COMMIT_WAIT_MS);

        await page.locator('.ProseMirror[contenteditable="true"]').click();
        const isMac = process.platform === "darwin";
        await page.keyboard.press(isMac ? "Meta+Z" : "Control+Z");

        await expect(page.locator(".encfile-node", { hasText: name })).toBeVisible({
            timeout: LIFECYCLE_TIMEOUT,
        });
        await expect(page.locator(".encfile-node", { hasText: "File in trash" })).toHaveCount(0);

        await showActive(page);
        await expect(fileCard(page, name)).toHaveCount(1, { timeout: LIFECYCLE_TIMEOUT });
    });

    test("a delete from /files → a restore from /trash", async ({ page }) => {
        const name = "restore-from-trash.txt";

        await uploadDocToFiles(page, name);
        await openFileDetailPanel(page, name);

        await moveToTrashFromFilePanel(page);

        await expect(fileCard(page, name)).toBeHidden({ timeout: LIFECYCLE_TIMEOUT });
        await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

        await restoreFromTrash(page, name);
        await showActive(page);
        await expect(fileCard(page, name)).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
    });

    test("chained: upload → delete → restore → delete again → finally TRASHED", async ({
        page,
    }) => {
        test.slow();
        const name = "undo-chain.txt";

        await uploadDocToFiles(page, name);
        await expect(fileCard(page, name)).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });

        await openFileDetailPanel(page, name);
        await moveToTrashFromFilePanel(page);
        await expect(fileCard(page, name)).toBeHidden({ timeout: LIFECYCLE_TIMEOUT });

        await restoreFromTrash(page, name);
        await showActive(page);
        await expect(fileCard(page, name)).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });

        await openFileDetailPanel(page, name);
        await moveToTrashFromFilePanel(page);
        await expect(fileCard(page, name)).toBeHidden({ timeout: LIFECYCLE_TIMEOUT });

        await showActive(page);
        await expect(fileCard(page, name)).toHaveCount(0, { timeout: LIFECYCLE_TIMEOUT });
        await showTrash(page);
        await expect(trashRow(page, name)).toHaveCount(1, { timeout: LIFECYCLE_TIMEOUT });
    });

    test("concurrent: deleting the second file during the first one's upload — both settle correctly", async ({
        page,
    }) => {
        const existing = "concurrent-existing.txt";
        const incoming = "concurrent-incoming.txt";

        await uploadDocToFiles(page, existing);

        await page.goto("/");
        await createNoteAndNavigate(page);
        // uploadToNote waits for the embed (the `local:` placeholder) to actually enter the editor
        // before we continue — without this the page.goto below can cut the upload short BEFORE
        // preparePendingUpload has even written the pending-uploads row into IDB (the upload never
        // starts,
        // so "incoming" never appears in /files — that is not real concurrency but a lost upload).
        await uploadToNote(page, incoming, "text/plain", Buffer.from(`concurrent ${Date.now()}`));

        await page.goto("/files");
        await openFileDetailPanel(page, existing);
        await moveToTrashFromFilePanel(page);
        // FileService.trash() is async (markDirtyAndPush plus the ref strip) — wait until it really
        // show in the UI BEFORE the hard navigation (showActive → page.goto). Without this, the goto can
        // cut the trash mutation short in flight, leaving "existing" Active after a reload.
        await expect(fileCard(page, existing)).toBeHidden({ timeout: LIFECYCLE_TIMEOUT });

        await showActive(page);
        await expect(fileCard(page, incoming)).toBeVisible({ timeout: 30_000 });
        await expect(fileCard(page, existing)).toHaveCount(0, { timeout: LIFECYCLE_TIMEOUT });
        await showTrash(page);
        await expect(trashRow(page, existing)).toHaveCount(1, { timeout: LIFECYCLE_TIMEOUT });
    });
});
