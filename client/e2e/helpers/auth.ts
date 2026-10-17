import { expect, type Page } from "@playwright/test";

export const E2E_API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const E2E_PASSWORD = "correct-horse-battery-staple";

/**
 * Creates a new vault and waits for the redirect into the app.
 *
 * Open-core has no account layer: `/create-vault` opens **without a pass**, which is a self-host's
 * first registration.
 *
 * The vault password is typed only on that screen — it is the only screen allowed to ask for it,
 * which is also where the checkbox about irreversible loss lives.
 */
export async function registerUser(page: Page, email: string, password: string): Promise<void> {
    await page.goto("/create-vault");
    await page.getByPlaceholder("Email Address").fill(email);
    const pwInputs = page.locator('input[type="password"]');
    await pwInputs.nth(0).fill(password);
    await pwInputs.nth(1).fill(password);
    await page.getByTestId("accept-dataloss").check();
    // The Argon2id derivation runs client-side; allow up to 60s for slow CI machines.
    await page.getByRole("button", { name: /Create Secure Vault/i }).click();

    await page.waitForURL(/\/login/, { timeout: 60_000 });

    await loginUser(page, email, password);
    await waitForAppReady(page);
}

/**
 * Waits for the initial pull to clear pendingClear, which blocks the home button.
 *
 * It uses waitForFunction (rather than page.evaluate inside expect.poll): in the PROD/PWA preview the
 * first SW claim fires controllerchange → a hard reload (initServiceWorkerUpdate), which destroys the
 * execution context and would throw "Execution context was destroyed". waitForFunction re-evaluates
 * itself automatically after a navigation.
 * After that we wait for the vault UI again — a reload can land mid-unlock.
 */
async function waitForAppReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => localStorage.getItem("cn_pending_clear_for_user") === null,
        null,
        { timeout: 30_000 },
    );
    await waitForVaultUnlocked(page);
}

/**
 * Signs in with existing credentials and waits for the redirect into the app.
 */
export async function loginUser(page: Page, email: string, password: string): Promise<void> {
    await page.goto("/login");
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Master password").fill(password);
    await Promise.all([
        page.waitForURL("/", { timeout: 60_000 }),
        page.getByRole("button", { name: /Unlock vault/i }).click(),
    ]);
    await waitForVaultUnlocked(page);
}

/**
 * Waits until the vault unlocks and the app shell becomes interactive.
 * It uses sidebar indicators present on every authenticated route — not the home-only
 * "New encrypted note" empty state (which is absent on /note/* after a reload).
 * (The footer no longer shows a "Vault unlocked" label — the lock button plus New note are the signal.)
 */
export async function waitForVaultUnlocked(page: Page): Promise<void> {
    await page.getByTitle("Lock vault & logout").waitFor({ timeout: 60_000 });
    await page.getByTitle("New note").waitFor({ timeout: 15_000 });
}

/**
 * Creates a new note and navigates to its editor page.
 * It uses the empty-state button "New encrypted note" (which calls goto internally), NOT the sidebar
 * button "New note" (which only creates the item in the tree, without navigating).
 */
export async function createNoteAndNavigate(page: Page): Promise<string> {
    await page.goto("/");
    const createBtn = page.getByRole("button", { name: /New encrypted note/i });
    await createBtn.waitFor({ state: "visible", timeout: 30_000 });
    await Promise.all([page.waitForURL(/\/note\//, { timeout: 30_000 }), createBtn.click()]);
    return page.url();
}

/** Generates a unique email address per test run. */
export function uniqueEmail(): string {
    return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

/** The default E2E password — one place of truth for the helper and the specs. */
export function e2ePassword(): string {
    return E2E_PASSWORD;
}

/** The editor breadcrumb bar (EditorHeader). */
export function editorBreadcrumbBar(page: Page) {
    return page.locator(".h-12.border-b").first();
}

/** The inline rename input inside the breadcrumb bar. */
export function breadcrumbRenameInput(page: Page) {
    return editorBreadcrumbBar(page).locator("input[type='text']");
}

/** Dismiss the automatically opened rename (?new=1) before the explicit dblclick rename path. */
export async function dismissBreadcrumbAutoRename(page: Page): Promise<void> {
    const input = breadcrumbRenameInput(page);
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.press("Escape");
    await expect(input).not.toBeVisible();
}

/** Renames the active note by double-clicking the last breadcrumb crumb. */
export async function renameActiveNoteViaBreadcrumb(page: Page, newTitle: string): Promise<void> {
    const bar = editorBreadcrumbBar(page);
    const input = breadcrumbRenameInput(page);
    await bar.locator(".truncate.font-medium").last().dblclick();
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill(newTitle);
    await input.press("Enter");
}
