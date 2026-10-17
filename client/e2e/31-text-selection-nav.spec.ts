import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

/**
 * An SPA leaves a native Selection Range behind after the main content is swapped (the layout stays).
 * A click on a tree-row (user-select: none + keepFocus) does not clear the highlight, so Chrome
 * remaps the range onto the sidebar menu + the new note.
 */
test.describe("Text selection across SPA navigation", () => {
    setupAuthenticatedUser();

    test("selecting text in Settings does not leave a highlight on the note after opening it", async ({
        page,
    }) => {
        await createNoteAndNavigate(page);
        await page.goto("/settings/shared-links");
        await expect(page.getByRole("heading", { name: "Shared links" })).toBeVisible();

        // A Cmd/Ctrl+A, or a drag from the sidebar into settings, leaves a Range on the persistent
        // layout. A tree-row click (user-select: none + keepFocus) does not clear it, so Chrome remaps
        // the highlight onto the sidebar menu + the note chrome. HTMLElement.click() sends only a
        // click — a Playwright mousedown would clear the selection and hide the bug.
        await page.evaluate(() => {
            const range = document.createRange();
            range.selectNodeContents(document.body);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        });
        expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");

        const noteRow = page.locator('[data-testid="folder-tree"] [data-node-type="note"]').first();
        await Promise.all([
            page.waitForURL(/\/note\//),
            noteRow.evaluate((el: HTMLElement) => el.click()),
        ]);

        const leftover = await page.evaluate(() => {
            const sel = window.getSelection();
            return {
                text: sel?.toString() ?? "",
                collapsed: sel?.isCollapsed ?? true,
            };
        });
        expect(leftover.collapsed, `leftover selection: ${JSON.stringify(leftover.text)}`).toBe(
            true,
        );
        expect(leftover.text).toBe("");
    });
});
