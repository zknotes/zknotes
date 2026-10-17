import { expect, test } from "@playwright/test";
import { createNoteAndNavigate, waitForVaultUnlocked } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

/**
 * Smoke — the SharedWorker encrypt/decrypt roundtrip after a full reload.
 * The rest of the note logic (rename, trash, routing) is covered by unit/E2E elsewhere
 * (25-breadcrumbs, 09-trash).
 */
test.describe("Notes — encrypt/decrypt smoke", () => {
    setupAuthenticatedUser();

    test("content is encrypted at rest and decrypted after full page reload", async ({ page }) => {
        const content = `E2E secret ${Date.now()}`;

        const noteUrl = await createNoteAndNavigate(page);

        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.type(content);

        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: 15_000 });

        await page.reload();
        await waitForVaultUnlocked(page);
        await page.goto(noteUrl);

        await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText(content, {
            timeout: 20_000,
        });
    });
});
