import { expect, test } from "@playwright/test";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import { createFolder } from "./helpers/folder-helper";

test.describe("Pinning (Selective Sync)", () => {
    setupAuthenticatedUser();

    test("folder can be pinned and unpinned via context menu", async ({ page }) => {
        // Create a folder in the sidebar tree
        await page.goto("/");
        const folderRow = await createFolder(page, "Pinned Folder");

        // Right-click → "Keep on this device"
        await folderRow.click({ button: "right" });
        await page.getByRole("button", { name: "Keep on this device" }).click();

        // The context menu now shows "Remove from device" (the pin is active)
        await folderRow.click({ button: "right" });
        await expect(page.getByRole("button", { name: "Remove from device" })).toBeVisible({
            timeout: 5000,
        });

        // Remove the pin
        await page.getByRole("button", { name: "Remove from device" }).click();

        // The context menu goes back to "Keep on this device"
        await folderRow.click({ button: "right" });
        await expect(page.getByRole("button", { name: "Keep on this device" })).toBeVisible({
            timeout: 5000,
        });

        // Close the menu
        await page.keyboard.press("Escape");
    });
});
