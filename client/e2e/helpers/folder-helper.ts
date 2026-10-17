import { expect, type Page } from "@playwright/test";

/**
 * Commits the inline rename textbox (which is autofocused) to the given name.
 * fill() is atomic — none of the early-character loss that happens with keyboard.type.
 */
async function commitRename(page: Page, name: string): Promise<void> {
    const input = page.getByRole("textbox");
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill(name);
    await input.press("Enter");
}

/**
 * Creates a folder through the sidebar button and commits the inline rename to the given name.
 * Returns a locator for the folder's row in the tree.
 */
export async function createFolder(page: Page, name: string) {
    await page.getByTitle("New folder", { exact: true }).click();
    await commitRename(page, name);
    const row = page.locator('[data-node-type="folder"]').filter({ hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    return row;
}
