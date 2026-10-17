import { expect, test } from "@playwright/test";
import { registerUser, uniqueEmail, waitForVaultUnlocked } from "./helpers/auth";

const PASSWORD = "correct-horse-battery-staple";
const SYNC_SETTINGS_KEY = "zknotes:sync-settings";

/**
 * Smoke — the Settings UI changes the auto-download policy in localStorage.
 * The Never→Download flow is covered by sync-settings.test.ts + chunk-loader.integration.test.ts.
 */
test.describe("Selective sync — Settings smoke", () => {
    test("Settings > Preferences changes the auto-download policy", async ({ page }) => {
        await registerUser(page, uniqueEmail(), PASSWORD);
        await waitForVaultUnlocked(page);
        await page.goto("/settings");

        await page.getByRole("link", { name: "Storage", exact: true }).click();

        const section = page.locator('[data-testid="auto-download-settings"]');
        await expect(section).toBeVisible();

        await page.getByRole("radio", { name: /None/i }).check();
        await expect(page.getByRole("radio", { name: /None/i })).toBeChecked();

        const saved = await page.evaluate(
            ([key]) => {
                const raw = localStorage.getItem(key);
                if (!raw) return null;
                try {
                    return (JSON.parse(raw) as { autoDownload?: string }).autoDownload ?? null;
                } catch {
                    return null;
                }
            },
            [SYNC_SETTINGS_KEY] as const,
        );
        expect(saved).toBe("never");
    });
});
