import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

test.describe("Sync activity panel", () => {
    setupAuthenticatedUser();

    test("opens from the status chip and shows the pending-changes section", async ({ page }) => {
        // A regression: the panel's effects must not spin into an infinite loop (reading and writing the same state).
        const loopErrors: string[] = [];
        page.on("console", (msg) => {
            if (/effect_update_depth_exceeded|Maximum update depth/i.test(msg.text())) {
                loopErrors.push(msg.text());
            }
        });

        // Creating a note enqueues a mutation → the panel has something to show.
        await createNoteAndNavigate(page);

        await page.getByTestId("sync-status").click();

        await expect(page.getByRole("heading", { name: "Sync activity" })).toBeVisible();
        await expect(page.getByText("Pending changes", { exact: false })).toBeVisible();

        // Escape closes the slide-over.
        await page.keyboard.press("Escape");
        await expect(page.getByRole("heading", { name: "Sync activity" })).toBeHidden();

        expect(loopErrors, loopErrors.join("\n")).toHaveLength(0);
    });
});
