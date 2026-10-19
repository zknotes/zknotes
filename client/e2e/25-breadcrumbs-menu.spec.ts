import { expect, test } from "@playwright/test";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

test.describe("Breadcrumbs Context Menu", () => {
    setupAuthenticatedUser();

    test("folder and note menus in breadcrumbs can change color, icon and rename", async ({
        page,
    }) => {
        const folderName = `Folder${Date.now()}`;
        const noteName = `Note${Date.now()}`;

        // 1. Create a folder using the sidebar "New folder" button
        await page.getByTitle("New folder", { exact: true }).click();

        // The sidebar's inline rename — not the ProseMirror (both are role=textbox while a note is open).
        const renameInput = page.locator(".tree-item-row input[type='text']");
        await renameInput.waitFor({ state: "visible", timeout: 10_000 });
        await renameInput.fill(folderName);
        await renameInput.press("Enter");

        const folderNode = page
            .locator('[data-node-type="folder"]')
            .filter({ hasText: folderName })
            .first();
        await expect(folderNode).toBeVisible({ timeout: 10000 });

        // 2. We create a Note inside the folder.
        await folderNode.click({ button: "right" });
        await page.getByText("New note").click();

        // Wait for inline rename input for note and fill the note name
        await renameInput.waitFor({ state: "visible", timeout: 10_000 });
        await renameInput.fill(noteName);
        await renameInput.press("Enter");

        // Click the note we created, to open it.
        const noteNode = page
            .locator('[data-node-type="note"]')
            .filter({ hasText: noteName })
            .first();
        await noteNode.click();

        await page.waitForURL(/\/note\//, { timeout: 10000 });

        // Click the editor to close any sidebar rename mode that may be open
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();

        // FOLDER BREADCRUMB TEST
        // Locate the header in the editor that holds the breadcrumbs
        const header = page.locator("header, .h-12.border-b").first(); // by the classes in EditorHeader.svelte

        // The crumb button (which has the title plus an inline colour style), not the inner title span
        const folderCrumb = header
            .locator(`[title="Click for options"]`, { hasText: folderName })
            .first();
        await folderCrumb.click();

        // The menu opens
        const ctxMenu = page.locator(".ctx-menu");
        await expect(ctxMenu).toBeVisible();

        // Click the first colour in the folder colour picker (only folders have this row)
        const colorPicker = ctxMenu.locator(".flex.gap-1.flex-wrap");
        await expect(colorPicker).toBeVisible();
        const firstColorBtn = colorPicker.locator('button[style*="background-color"]').first();
        await expect(firstColorBtn).toBeVisible();
        await firstColorBtn.click();

        // We expect the menu to close and the colour to be applied (a node in the tree or in the breadcrumbs changes style)
        await expect(ctxMenu).not.toBeVisible();
        await expect(folderCrumb).toHaveAttribute("style", /color:/, { timeout: 10_000 });
        await expect(
            page
                .locator('[data-node-type="folder"]')
                .filter({ hasText: folderName })
                .locator("span.truncate.font-semibold")
                .first(),
        ).toHaveAttribute("style", /color:/, { timeout: 10_000 });

        // Open it again
        await folderCrumb.click();
        await expect(ctxMenu).toBeVisible();

        // Change the icon (the first icon from the preset list)
        const emojiBtn = ctxMenu.locator(".grid.grid-cols-8 button").first();
        const emojiText = await emojiBtn.innerText();
        await emojiBtn.click();

        await expect(ctxMenu).not.toBeVisible();
        // We expect the crumb to carry that icon
        await expect(folderCrumb).toContainText(emojiText, { timeout: 5000 });

        // Rename the folder through the breadcrumb menu
        await folderCrumb.click();
        await ctxMenu.getByText("Rename").click();

        const folderRenameInput = header.locator("input").first();
        await folderRenameInput.fill("E2E Folder");
        await folderRenameInput.press("Enter");

        // Breadcrumb text changed
        const newFolderCrumb = header.locator("span", { hasText: "E2E Folder" }).first();
        await expect(newFolderCrumb).toBeVisible({ timeout: 5000 });

        // NOTE BREADCRUMB TEST
        const noteCrumb = header.locator("span", { hasText: noteName }).first();
        await noteCrumb.click();
        await expect(ctxMenu).toBeVisible();

        // A note has no colour picker in its menu, but it does have a rename.
        await ctxMenu.getByText("Rename").click();
        const noteRenameInput = header.locator("input").first();
        await noteRenameInput.fill("E2E Note");
        await noteRenameInput.press("Enter");

        const newNoteCrumb = header.locator("span", { hasText: "E2E Note" }).first();
        await expect(newNoteCrumb).toBeVisible({ timeout: 5000 });
    });

    test("sidebar context-menu New note focuses tree rename so typing works", async ({ page }) => {
        const folderName = `CtxFolder${Date.now()}`;
        const noteName = `Typed${Date.now()}`;

        await page.getByTitle("New folder", { exact: true }).click();
        const renameInput = page.locator(".tree-item-row input[type='text']");
        await renameInput.waitFor({ state: "visible", timeout: 10_000 });
        await renameInput.fill(folderName);
        await renameInput.press("Enter");

        const folderNode = page
            .locator('[data-node-type="folder"]')
            .filter({ hasText: folderName })
            .first();
        await expect(folderNode).toBeVisible({ timeout: 10_000 });

        await folderNode.click({ button: "right" });
        await page
            .locator(".ctx-menu")
            .getByRole("button", { name: "New note", exact: true })
            .click();

        await renameInput.waitFor({ state: "visible", timeout: 10_000 });
        // A fill()/click() would focus the field themselves and hide the bug — type as a user does.
        await expect(renameInput).toBeFocused({ timeout: 5_000 });
        await page.keyboard.type(noteName);
        await expect(renameInput).toHaveValue(noteName);
        await renameInput.press("Enter");

        await expect(
            page.locator('[data-node-type="note"]').filter({ hasText: noteName }).first(),
        ).toBeVisible({ timeout: 10_000 });
    });
});
