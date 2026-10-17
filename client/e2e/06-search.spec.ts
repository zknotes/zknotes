import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

/**
 * Smoke — SearchDialog UI wiring (folded in from the former 11-tree-search).
 * The index: index.integration.test.ts; expandedFolders: expanded-folders.test.ts.
 */
test.describe("Search & tree — smoke", () => {
    setupAuthenticatedUser();

    test("can search by note content and open result", async ({ page }) => {
        const uniqueWord = `Classified${Date.now()}`;

        await createNoteAndNavigate(page);

        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.type(`This note contains the word ${uniqueWord} inside it.`);

        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        await page.getByText("Search vault…").click();

        const searchInput = page.getByPlaceholder("Search notes, folders…");
        await expect(searchInput).toBeVisible({ timeout: 10_000 });
        await expect(searchInput).toBeEnabled();
        await searchInput.fill(uniqueWord);

        const hitButton = page.locator("dialog button", { hasText: "Untitled" }).first();
        await expect(hitButton).toBeVisible({ timeout: 15_000 });
        await hitButton.click();

        await expect(searchInput).not.toBeVisible();
        await expect(editor).toBeVisible();
    });

    test("SearchDialog ArrowDown opens existing note (Enter does not create new)", async ({
        page,
    }) => {
        const word = `Needle${Date.now()}`;

        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.type(`This note holds the secret ${word} token.`);
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        await page.keyboard.press("Control+k");
        const searchInput = page.getByPlaceholder("Search notes, folders…");
        await expect(searchInput).toBeVisible({ timeout: 10_000 });
        await searchInput.fill(word);

        await expect(page.locator("dialog button", { hasText: "Untitled" }).first()).toBeVisible({
            timeout: 15_000,
        });

        await searchInput.press("ArrowDown");
        await searchInput.press("Enter");

        await page.waitForURL(/\/note\//, { timeout: 15_000 });
        await expect(editor).toContainText(word, { timeout: 10_000 });
    });
});
