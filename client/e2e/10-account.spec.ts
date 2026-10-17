import { expect, test } from "@playwright/test";
import { loginUser, registerUser, uniqueEmail, waitForVaultUnlocked } from "./helpers/auth";

const PASSWORD = "correct-horse-battery-staple";

/**
 * Smoke — a password change with the real crypto rewrap.
 * Logout/teardown: session-service.integration.test.ts; the performChangePassword mock:
 * auth-service.integration.test.ts.
 */
test.describe("Account — password change smoke", () => {
    test("password change re-encrypts vault; new password unlocks, old one fails", async ({
        page,
    }) => {
        const email = uniqueEmail();
        const NEW_PASSWORD = "brand-new-master-passphrase-9000";

        await registerUser(page, email, PASSWORD);
        await waitForVaultUnlocked(page);

        // Change the password in Settings
        await page.goto("/settings");
        await page.getByPlaceholder("Enter your current password").fill(PASSWORD);
        await page.getByPlaceholder("New password", { exact: true }).fill(NEW_PASSWORD);
        await page.getByPlaceholder("Repeat new password").fill(NEW_PASSWORD);
        await page.locator("#understandConsequences").check();
        await page.getByRole("button", { name: /^Change password$/i }).click();

        await expect(page.getByText(/Password changed successfully/i)).toBeVisible({
            timeout: 60_000,
        });

        // Log out, then log in with the NEW password → it has to unlock (proof the rewrap worked)
        await page.getByTitle("Lock vault & logout").click();
        await page.waitForURL(/\/login/, { timeout: 30_000 });
        await loginUser(page, email, NEW_PASSWORD);
        await waitForVaultUnlocked(page);

        // The OLD password must no longer unlock anything
        await page.getByTitle("Lock vault & logout").click();
        await page.waitForURL(/\/login/, { timeout: 30_000 });
        await page.getByPlaceholder("Email").fill(email);
        await page.getByPlaceholder("Master password").fill(PASSWORD);
        await page.getByRole("button", { name: /Unlock vault/i }).click();
        await expect(page.getByText(/Wrong email or password|Login failed/)).toBeVisible({
            timeout: 60_000,
        });
        expect(page.url()).toContain("/login");
    });
});
