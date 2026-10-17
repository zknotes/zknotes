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
 * Smoke — the live file reference in a history restore.
 * Snapshot dedup/decrypt/AAD: history.integration.test.ts.
 */
test.describe("Version History — live embed smoke", () => {
    setupAuthenticatedUser();

    test("a history embed is a live reference — a restore shows the renamed file, not the old one", async ({
        page,
    }) => {
        test.slow();
        const v1 = "live-v1.pdf";
        const v2 = "live-v2.pdf";

        const noteUrl = await createNoteAndNavigate(page);
        await expect(page.locator('[data-node-type="note"]').first()).toBeVisible({
            timeout: LIFECYCLE_TIMEOUT,
        });

        await uploadToNote(page, v1, "application/pdf", Buffer.from("history live ref pdf"));
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });
        const fileId = await captureEmbedFileId(page);
        await openFilesTabInNote(page);
        await expect(fileCard(page, v1)).toBeVisible({ timeout: 30_000 });
        await openEditorTabInNote(page, noteUrl);

        const historyBtn = page.getByRole("button", { name: "Toggle version history" });
        await historyBtn.click();
        await page.locator('button[title="Save current state to history"]').click();
        await expect(page.getByRole("button", { name: "Saved!" })).toBeVisible({ timeout: 10_000 });

        await openFilesTabInNote(page);
        await openFileDetailPanel(page, v1);
        await filePanel(page).locator("input").first().fill(v2);
        await page.getByRole("button", { name: /Save changes/ }).click();
        await expectFileRenamedInList(page, v1, v2);
        await closeFilePanel(page);

        await openEditorTabInNote(page, noteUrl);
        await expectEmbedRenamed(page, fileId, v2, v1);

        await historyBtn.click();
        const snapshotItem = page.locator('li[role="option"]').first();
        await expect(snapshotItem).toBeVisible();
        await snapshotItem.click();
        await page.getByRole("button", { name: "Restore this version" }).last().click();

        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await expect(editor).toBeVisible();
        await expectEmbedRenamed(page, fileId, v2, v1, editor);
    });
});
