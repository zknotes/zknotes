import { expect, type Page, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import { redPngBuffer, UPLOAD_TIMEOUT } from "./helpers/files";

/**
 * "Lock vault & logout" warns while `getUnsyncedWork().uploadsActive > 0`.
 * The POST /uploads is deliberately hung, so the pending-uploads row stays non-terminal.
 */

function isUploadSessionOpen(url: URL | string, method: string): boolean {
    if (method !== "POST") return false;
    const pathname = typeof url === "string" ? new URL(url).pathname : url.pathname;
    return /\/uploads$/.test(pathname);
}

async function hangUploadSession(page: Page): Promise<void> {
    // context.route — IDB is origin-scoped; the other tab must not be allowed to finish the session open.
    await page.context().route(
        (url) => /\/uploads$/.test(url.pathname),
        async (route) => {
            if (route.request().method() !== "POST") {
                await route.continue();
                return;
            }
            await new Promise(() => {});
        },
    );
}

async function startHungNoteUpload(page: Page, name: string): Promise<void> {
    const sessionOpen = page.waitForRequest((req) => isUploadSessionOpen(req.url(), req.method()), {
        timeout: UPLOAD_TIMEOUT,
    });
    await createNoteAndNavigate(page);
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: UPLOAD_TIMEOUT });
    await editor.click();
    await page.locator(".editor-toolbar + input[type='file']").setInputFiles({
        name,
        mimeType: "image/png",
        buffer: redPngBuffer(),
    });
    await sessionOpen;
}

function uploadsDialog(page: Page) {
    return page.getByRole("dialog").filter({ hasText: "Uploads in progress" });
}

test.describe("Logout warns on pending upload", () => {
    setupAuthenticatedUser();

    test("lock without an active upload goes straight to login", async ({ page }) => {
        await page.goto("/");
        await page.getByTitle("Lock vault & logout").click();
        await page.waitForURL(/\/login/, { timeout: 30_000 });
        await expect(uploadsDialog(page)).toHaveCount(0);
    });

    test("pending upload: dialog shows the count; Cancel leaves the session and re-opens", async ({
        page,
    }) => {
        await hangUploadSession(page);
        await startHungNoteUpload(page, "pending-logout.png");

        await page.getByTitle("Lock vault & logout").click();
        const dialog = uploadsDialog(page);
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await expect(dialog).toContainText(
            "1 file upload still in progress. Logging out will cancel it and the data cannot be recovered.",
        );

        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toBeHidden();
        await expect(page).not.toHaveURL(/\/login/);
        await expect(page.getByTitle("Lock vault & logout")).toBeVisible();

        await page.getByTitle("Lock vault & logout").click();
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await expect(page).not.toHaveURL(/\/login/);
    });

    test("Log out anyway proceeds to login", async ({ page }) => {
        await hangUploadSession(page);
        await startHungNoteUpload(page, "logout-anyway.png");

        await page.getByTitle("Lock vault & logout").click();
        const dialog = uploadsDialog(page);
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await dialog.getByRole("button", { name: "Log out anyway" }).click();
        await page.waitForURL(/\/login/, { timeout: 30_000 });
        await expect(page.getByTitle("Lock vault & logout")).toHaveCount(0);
    });

    test("Ctrl+Shift+Esc uses the same pending-upload guard as the lock button", async ({
        page,
    }) => {
        await hangUploadSession(page);
        await startHungNoteUpload(page, "shortcut-logout.png");

        await page.keyboard.press("Control+Shift+Escape");
        await expect(uploadsDialog(page)).toBeVisible({ timeout: 10_000 });
        await expect(page).not.toHaveURL(/\/login/);
    });

    test("upload started in another tab still warns on logout (IDB-aware)", async ({
        page,
        context,
    }) => {
        await hangUploadSession(page);
        await startHungNoteUpload(page, "other-tab.png");

        const pageB = await context.newPage();
        await pageB.goto("/");
        await pageB.getByTitle("Lock vault & logout").waitFor({ timeout: 60_000 });

        await pageB.getByTitle("Lock vault & logout").click();
        const dialog = uploadsDialog(pageB);
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await expect(dialog).toContainText("1 file upload still in progress");
        await expect(pageB).not.toHaveURL(/\/login/);
        await pageB.close();
    });
});
