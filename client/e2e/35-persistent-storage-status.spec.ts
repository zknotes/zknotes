import { expect, type Page, test } from "@playwright/test";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

const PERSIST_KEY = "cn_persistent_storage";

type PersistOutcome = "persisted" | "denied" | "unsupported";

/**
 * Settings → Storage shows all three outcomes of `persist()`.
 * We seed the raw `cn_persistent_storage` string (no JSON quotes) once the layout's
 * `requestPersistentStorage()` has finished, then navigate client-side into Settings.
 * A `page.goto("/settings")` would reset the module-level `attempted`, and `remember()` would
 * overwrite the seed with the real outcome (`"denied"` in this Chromium).
 */
async function openStorageWithOutcome(page: Page, outcome: PersistOutcome | null): Promise<void> {
    await page.waitForFunction((key) => localStorage.getItem(key) !== null, PERSIST_KEY, {
        timeout: 15_000,
    });
    await page.evaluate(
        ([key, value]) => {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        },
        [PERSIST_KEY, outcome] as const,
    );

    await page.getByTitle("Settings and preferences").click();
    await page.locator(".ctx-item", { hasText: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings/);
    await page.getByRole("link", { name: "Storage", exact: true }).click();
}

function persistStatus(page: Page) {
    return page.getByTestId("persist-status");
}

test.describe("Persistent storage status in Settings", () => {
    setupAuthenticatedUser();

    test("shows persisted when localStorage holds persisted", async ({ page }) => {
        await openStorageWithOutcome(page, "persisted");
        const row = persistStatus(page);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute("data-outcome", "persisted");
        await expect(row).toContainText("Persistent storage is active");
    });

    test("shows denied banner copy when localStorage holds denied", async ({ page }) => {
        await openStorageWithOutcome(page, "denied");
        const row = persistStatus(page);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute("data-outcome", "denied");
        await expect(row).toContainText("Offline storage is not persistent");
        await expect(row).toContainText(
            "Your browser may clear locally stored notes under storage pressure. Install the app (Add to Home Screen / Install) to keep your data reliably available offline.",
        );
    });

    test("shows unsupported when localStorage holds unsupported", async ({ page }) => {
        await openStorageWithOutcome(page, "unsupported");
        const row = persistStatus(page);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute("data-outcome", "unsupported");
        await expect(row).toContainText("Persistent storage isn't supported by this browser");
    });

    test("shows unsupported when the persist key is missing", async ({ page }) => {
        await openStorageWithOutcome(page, null);
        const row = persistStatus(page);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute("data-outcome", "unsupported");
        await expect(row).toContainText("Persistent storage isn't supported by this browser");
    });
});
