import { expect, test } from "@playwright/test";
import {
    createNoteAndNavigate,
    dismissBreadcrumbAutoRename,
    renameActiveNoteViaBreadcrumb,
} from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import {
    captureEmbedFileId,
    fileCard,
    filePanel,
    moveToTrashFromFilePanel,
    openEditorTabInNote,
    openFileDetailPanel,
    openFilesTabInNote,
    restoreFromTrash,
    uploadToNote,
} from "./helpers/files";

test.describe("Files in Notes", () => {
    setupAuthenticatedUser();

    test("upload PDF → delete → see placeholder → restore → move to another note", async ({
        page,
    }) => {
        test.slow();
        const fileName = "e2e-note-upload.pdf";

        // 1. Create the first note
        const noteUrl1 = await createNoteAndNavigate(page);

        // Rename the first note to "Note 1" to avoid confusion
        await dismissBreadcrumbAutoRename(page);
        await renameActiveNoteViaBreadcrumb(page, "Note 1");

        // Upload a PDF through the hidden file input, then confirm "Upload" (it waits for the embed chip).
        await uploadToNote(page, fileName, "application/pdf", Buffer.from("fake pdf content"));

        // Upload → wait for a real embed (a real fileId, not a "local:" placeholder — the swap has to
        // finish before Ctrl+S, or the note is saved with a stale `local:` ref that the delete
        // invalidation
        // does not recognise later, because it looks for the real fileId) → save BEFORE navigating.
        await expect(page.locator(".encfile-node", { hasText: fileName })).toBeVisible({
            timeout: 30_000,
        });
        await captureEmbedFileId(page);
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: 15_000 });

        // Check the file exists in /files
        await openFilesTabInNote(page);
        await expect(fileCard(page, fileName)).toBeVisible({ timeout: 30_000 });

        // 2. Create the second note
        await page.goto("/");
        const noteUrl2 = await createNoteAndNavigate(page);

        // Rename the second note to "Note 2"
        await dismissBreadcrumbAutoRename(page);
        await renameActiveNoteViaBreadcrumb(page, "Note 2");

        // Wait for the rename to save and appear in the sidebar
        await expect(
            page.locator('[data-node-type="note"]').filter({ hasText: "Note 2" }),
        ).toBeVisible({ timeout: 15_000 });

        // 3. Go back to the first note
        await page.goto(noteUrl1);
        await expect(page.locator(".encfile-node", { hasText: fileName })).toBeVisible({
            timeout: 15_000,
        });

        // 4. Delete the file from the /files page (FileDetailPanel → Delete)
        await openFilesTabInNote(page);
        const card = fileCard(page, fileName);
        await expect(card).toBeVisible({ timeout: 30_000 });
        await openFileDetailPanel(page, fileName);
        await moveToTrashFromFilePanel(page);
        await expect(card).toBeHidden({ timeout: 30_000 });

        // 5. A delete from /files strips the embed (there is no "File in trash" placeholder)
        await openEditorTabInNote(page, noteUrl1);
        await expect(page.locator(".encfile-node", { hasText: fileName })).toBeHidden({
            timeout: 15_000,
        });

        // 6. A restore from /trash appends the embed to the end of the note
        await restoreFromTrash(page, fileName);

        // 7. Check that the file is back in the note
        await page.goto(noteUrl1);
        await expect(page.locator(".encfile-node", { hasText: fileName })).toBeVisible({
            timeout: 15_000,
        });

        // 8. Move the file from the detail panel into the second note
        await openFilesTabInNote(page);

        // Open the detail panel from the /files page
        await openFileDetailPanel(page, fileName);

        // Click the move button
        await page.getByRole("button", { name: /Move to another note/i }).click();

        // Pick "Note 2" from the picker modal
        await page.locator('dialog [role="button"]').filter({ hasText: "Note 2" }).first().click();

        // The move is async (it decrypts and re-encrypts both notes) — the panel closes only ONCE it
        // finishes (FileDetailPanel.onMoveToNote awaits FileService.move before onClose()). Wait for
        // that signal before a hard navigation (page.goto), or page.goto can cut the move short.
        await expect(filePanel(page)).toBeHidden({ timeout: 15_000 });

        // The embed moved from Note 1 into Note 2 (the file stays in /files — a global manager).
        await page.goto(noteUrl1);
        await expect(page.locator(".encfile-node", { hasText: fileName })).toBeHidden({
            timeout: 10_000,
        });

        // 9. Check the embed is in Note 2
        await page.goto(noteUrl2);
        await expect(page.locator(".encfile-node", { hasText: fileName })).toBeVisible({
            timeout: 10_000,
        });
    });
});
