import { expect, test } from "@playwright/test";
import {
    createNoteAndNavigate,
    registerUser,
    uniqueEmail,
    waitForVaultUnlocked,
} from "./helpers/auth";

const PASSWORD = "correct-horse-battery-staple";

/**
 * Smoke — the canonical classes in Settings and Share (not pixel-by-theme).
 */
test.describe("Form controls — canonical classes", () => {
    test("Settings: checkbox / radio / select carry .checkbox / .radio / .input", async ({
        page,
    }) => {
        await registerUser(page, uniqueEmail(), PASSWORD);
        await waitForVaultUnlocked(page);
        await page.goto("/settings/preferences");

        const timeRadio = page.getByRole("radio", { name: "System" }).first();
        await expect(timeRadio).toBeVisible();
        await expect(timeRadio).toHaveClass(/\bradio\b/);

        const timezone = page.locator("#timezone");
        await expect(timezone).toHaveClass(/\binput\b/);

        // Preferences has no checkbox any more, so it is checked on the Backup card; the Export
        // card has one with the same label, hence the scope.
        await page.goto("/settings/backup");
        const includeFiles = page
            .getByTestId("backup-create")
            .getByRole("checkbox", { name: "File attachments" });
        await expect(includeFiles).toBeVisible();
        await expect(includeFiles).toHaveClass(/\bcheckbox\b/);
    });

    test("Share dialog: radio / select / checkbox carry the canonical classes", async ({
        page,
    }) => {
        await registerUser(page, uniqueEmail(), PASSWORD);
        await waitForVaultUnlocked(page);
        await createNoteAndNavigate(page);

        await page.getByRole("button", { name: "Share" }).click();
        await expect(page.getByRole("heading", { name: /Share this note/i })).toBeVisible();

        const typeRadio = page.getByRole("radio", { name: /Standard link/i });
        await expect(typeRadio).toHaveClass(/\bradio\b/);

        const ttl = page.locator("select.input");
        await expect(ttl).toHaveClass(/\binput\b/);
        await expect(ttl).toHaveClass(/\binput-sm\b/);

        const passwordCheck = page.getByRole("checkbox", { name: /Also require a password/i });
        await expect(passwordCheck).toHaveClass(/\bcheckbox\b/);
    });
});
