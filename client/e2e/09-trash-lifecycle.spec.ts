import { expect, test } from "@playwright/test";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

/**
 * A smoke test — the /trash UI wiring after a folder cascade delete.
 * The business logic (delete/restore/permanent cascade) is covered in
 * item-service.cascade.integration.test.ts; the E2E only confirms the UI shows 2 trash rows (the
 * folder + its child) without a full-page-reload race.
 */
test.describe("Trash lifecycle — folder cascade smoke", () => {
    setupAuthenticatedUser();

    async function commitRename(page: import("@playwright/test").Page, name: string) {
        const input = page.getByRole("textbox");
        await input.waitFor({ state: "visible", timeout: 10_000 });
        await input.fill(name);
        await input.press("Enter");
    }

    async function createFolder(page: import("@playwright/test").Page, name: string) {
        await page.getByTitle("New folder", { exact: true }).click();
        await commitRename(page, name);
        const row = page.locator('[data-node-type="folder"]').filter({ hasText: name }).first();
        await expect(row).toBeVisible({ timeout: 10_000 });
        return row;
    }

    async function goToTrash(page: import("@playwright/test").Page) {
        await page.getByTitle("Trash").click();
        await page.waitForURL("**/trash", { timeout: 10_000 });
    }

    test("folder delete → /trash shows folder and child (cascade smoke)", async ({ page }) => {
        const folderName = `Parent${Date.now()}`;
        const childName = `Child${Date.now()}`;

        const folderRow = await createFolder(page, folderName);
        await folderRow.click();
        await page.getByTitle("New note", { exact: true }).click();
        await commitRename(page, childName);

        await expect(
            page.locator('[data-node-type="note"]').filter({ hasText: childName }),
        ).toBeVisible({ timeout: 10_000 });

        await folderRow.click({ button: "right" });
        await page.getByText("Move to trash").click();
        await expect(folderRow).not.toBeVisible({ timeout: 10_000 });

        await goToTrash(page);
        await expect(page.getByRole("button", { name: /Empty trash/i })).toBeVisible({
            timeout: 15_000,
        });
        // Two buttons per row (the folder + its child); the dialog's confirm is scoped to role="dialog"
        const deleteForever = page
            .locator("main, [class*='max-w-6xl']")
            .first()
            .getByRole("button", { name: /Delete forever/i });
        await expect(deleteForever).toHaveCount(2);
        await expect(page.getByText(folderName, { exact: true })).toBeVisible();
        await expect(page.getByText(childName, { exact: true })).toBeVisible();
    });
});
