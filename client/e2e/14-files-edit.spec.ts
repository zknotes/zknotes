import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import {
    captureEmbedFileId,
    closeFilePanel,
    expectEmbedRenamed,
    expectFileRenamedInList,
    fileCard,
    filePanel,
    LIFECYCLE_TIMEOUT,
    openEditorTabInNote,
    openFileDetailPanel,
    openFilesTabInNote,
    uploadToNote,
} from "./helpers/files";

/**
 * Smoke — cross-surface invalidation (list ↔ panel ↔ embed) on a rename.
 * The crop/replace logic is partly covered by unit tests; the E2E holds one wiring path.
 */
test.describe("Files — edit smoke (rename invalidation)", () => {
    setupAuthenticatedUser();

    test("a rename in the FileDetailPanel refreshes the list, the panel and the embed without a reload", async ({
        page,
    }) => {
        test.slow();
        const original = "edit-rename.pdf";
        const renamed = "edit-renamed.pdf";

        const noteUrl = await createNoteAndNavigate(page);
        await expect(page.locator('[data-node-type="note"]').first()).toBeVisible({
            timeout: LIFECYCLE_TIMEOUT,
        });
        await uploadToNote(page, original, "application/pdf", Buffer.from("rename target pdf"));
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
        const fileId = await captureEmbedFileId(page);

        await openFilesTabInNote(page);
        await expect(fileCard(page, original)).toBeVisible({ timeout: 30_000 });
        await openFileDetailPanel(page, original);

        const nameInput = filePanel(page).locator("input").first();
        await nameInput.fill(renamed);
        await page.getByRole("button", { name: /Save changes/ }).click();

        await expectFileRenamedInList(page, original, renamed);
        await closeFilePanel(page);

        await openEditorTabInNote(page, noteUrl);
        await expectEmbedRenamed(page, fileId, renamed, original);
    });
});
