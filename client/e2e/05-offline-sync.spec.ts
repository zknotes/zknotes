import { expect, test } from "@playwright/test";
import { createNoteAndNavigate, waitForVaultUnlocked } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

test.describe("Sync Engine — Offline support", () => {
    setupAuthenticatedUser();

    test("offline changes are saved locally and synced when online", async ({ page, context }) => {
        const offlineContent = `Offline change ${Date.now()}`;

        const noteUrl = await createNoteAndNavigate(page);

        // Click the editor and type the initial content
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.type("Initial content");
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        // Go offline
        await context.setOffline(true);

        // The offline banner has to become visible
        await expect(page.locator("text=/Offline — changes will sync/i")).toBeVisible({
            timeout: 10_000,
        });

        // Change the note
        await editor.click();
        await editor.fill(""); // clear
        await editor.type(offlineContent);
        await page.keyboard.press("Control+s");

        // The pending indicator has to show the unsent change
        await expect(page.locator("text=/pending/i").first()).toBeVisible({ timeout: 15_000 });

        // Come back online
        await context.setOffline(false);

        // The banner and the pending indicator disappear after a successful drain
        await expect(page.locator("text=/Offline — changes will sync/i")).toBeHidden({
            timeout: 30_000,
        });
        await expect(page.locator("text=/pending/i")).toHaveCount(0, { timeout: 30_000 });

        // Reload the page, to confirm the changes really were saved to the backend
        await page.reload();
        await waitForVaultUnlocked(page);

        await page.goto(noteUrl);

        // The editor must contain the content written while it was offline
        await expect(page.locator('.ProseMirror[contenteditable="true"]')).toContainText(
            offlineContent,
            {
                timeout: 20_000,
            },
        );
    });
});
