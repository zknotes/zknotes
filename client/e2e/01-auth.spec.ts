import { expect, test } from "@playwright/test";
import { E2E_SOURCE_URL } from "../playwright.shared";
import { loginUser, registerUser, uniqueEmail, waitForVaultUnlocked } from "./helpers/auth";

test.describe("Authentication", () => {
    test("register creates account and unlocks vault", async ({ page }) => {
        const email = uniqueEmail();
        const password = "correct-horse-battery-staple";

        await registerUser(page, email, password);
        await waitForVaultUnlocked(page);

        // The sidebar is visible and the vault is unlocked
        await expect(page.getByTitle("New note")).toBeVisible();
        expect(page.url()).toMatch(/\/$/);
    });

    test("login with correct credentials unlocks vault", async ({ page }) => {
        const email = uniqueEmail();
        const password = "correct-horse-battery-staple";

        // Register first, so the account exists
        await registerUser(page, email, password);
        await waitForVaultUnlocked(page);

        // Log out through the lock button (clear sessionStorage by hand, then navigate to login)
        await page.evaluate(() => sessionStorage.clear());
        await loginUser(page, email, password);
        await waitForVaultUnlocked(page);

        await expect(page.getByTitle("New note")).toBeVisible();
    });

    test("login with wrong password shows error", async ({ page }) => {
        const email = uniqueEmail();
        const password = "correct-horse-battery-staple";

        // Register first, so the email exists
        await registerUser(page, email, password);
        await page.context().clearCookies();
        await page.evaluate(() => sessionStorage.clear());

        await page.goto("/login");
        await page.getByPlaceholder("Email").fill(email);
        await page.getByPlaceholder("Master password").fill("wrong-password-entirely");
        await page.getByRole("button", { name: /Unlock vault/i }).click();

        // It has to stay on /login and show an error (the API's "Invalid credentials", reworded)
        await expect(page.getByText(/Wrong email or password|Login failed/)).toBeVisible({
            timeout: 15_000,
        });
        expect(page.url()).toContain("/login");
    });

    // Accepting the Terms and the registration's anti-enumeration do not live in the vault — an
    // extension that adds an account layer covers them. What is left is the one tick box that is
    // still here: irrecoverable data loss.
    test("create-vault submit stays disabled until the data-loss box is checked", async ({
        page,
    }) => {
        const password = "correct-horse-battery-staple";

        await page.goto("/create-vault");
        await page.getByPlaceholder("Email Address").fill(uniqueEmail());
        const pwInputs = page.locator('input[type="password"]');
        await pwInputs.nth(0).fill(password);
        await pwInputs.nth(1).fill(password);

        const submit = page.getByRole("button", { name: /Create Secure Vault/i });
        await expect(submit).toBeDisabled();

        await page.getByTestId("accept-dataloss").check();
        await expect(submit).toBeEnabled();
    });

    // Regression: the link pointed at `/register`, a route that does not exist — on a self-host the
    // only way to reach vault creation was typing the address by hand. The destination is a runtime
    // decision (`/instance-config` + `/auth/registration-status`), and this covers the self-host
    // branch: no account layer, registration open → the core route.
    test("login offers the vault-creation page when registration is open", async ({ page }) => {
        await page.goto("/login");

        const signup = page.getByTestId("login-signup-link");
        await expect(signup).toBeVisible();
        await expect(signup).toHaveAttribute("href", "/create-vault");

        await signup.click();
        await expect(page).toHaveURL(/\/create-vault/);
        await expect(page.getByPlaceholder("Email Address")).toBeVisible();
    });
});

// AGPL-3.0 §13: whoever uses the instance over the network is offered its source — the visitors of
// the sign-in page and share recipients too, who never reach Settings → About.
test.describe("Licence and source offer", () => {
    test("the sign-in page shows the licence and links to the source", async ({ page }) => {
        await page.goto("/login");
        await expect(page.getByTestId("legal-footer")).toContainText("GNU AGPL-3.0");
        await expect(page.getByTestId("legal-footer-source")).toHaveAttribute(
            "href",
            E2E_SOURCE_URL,
        );
    });

    test("a share page shows them too, with no account", async ({ page }) => {
        await page.goto("/s/0190f6a0-0000-7000-8000-000000000001");
        await expect(page.getByTestId("legal-footer")).toContainText("without any warranty");
        await expect(page.getByTestId("legal-footer-source")).toHaveAttribute(
            "href",
            E2E_SOURCE_URL,
        );
    });
});
