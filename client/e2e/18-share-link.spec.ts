import { expect, test } from "@playwright/test";
import { createNoteAndNavigate, waitForVaultUnlocked } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import { exportEncryptedBackup, restoreBackup, waitForSyncIdle } from "./helpers/backup";

test.describe("Share link — recipient view", () => {
    setupAuthenticatedUser();

    test("create link, open without session, view note content", async ({ page, context }) => {
        const secret = `Share E2E ${Date.now()}`;
        const noteUrl = await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.type(secret);
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Share" }).click();
        await page.getByRole("button", { name: "Create link" }).click();
        await expect(page.getByText("Link ready")).toBeVisible({ timeout: 15_000 });

        const linkText = await page.locator("p.font-mono").innerText();
        expect(linkText).toContain("/s/");
        expect(linkText).toContain("#k=");

        const guest = await context.browser()!.newContext();
        const guestPage = await guest.newPage();
        await guestPage.goto(linkText);
        await guestPage.getByRole("button", { name: "View note" }).click();
        await expect(guestPage.locator("article")).toContainText(secret, { timeout: 20_000 });
        await guest.close();

        await page.goto(noteUrl);
        await waitForVaultUnlocked(page);
        const updated = `Updated ${secret}`;
        await editor.click();
        await editor.fill(updated);
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: 15_000 });

        const guest2 = await context.browser()!.newContext();
        const guestPage2 = await guest2.newPage();
        await guestPage2.goto(linkText);
        await guestPage2.getByRole("button", { name: "View note" }).click();
        await expect(guestPage2.locator("article")).toContainText(updated, { timeout: 20_000 });
        await guest2.close();
    });

    test("password-protected link: guest enters password and views note", async ({
        page,
        context,
    }) => {
        const secret = `Share pwd E2E ${Date.now()}`;
        const sharePassword = "share-test-password-42";
        const noteUrl = await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.type(secret);
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Share" }).click();
        await page.getByLabel("Also require a password").check();
        await page.getByPlaceholder("Share password").fill(sharePassword);
        await page.getByRole("button", { name: "Create link" }).click();
        await expect(page.getByText("Link ready")).toBeVisible({ timeout: 15_000 });

        const linkText = await page.locator("p.font-mono").innerText();
        expect(linkText).toContain("#k=");

        const guest = await context.browser()!.newContext();
        const guestPage = await guest.newPage();
        await guestPage.goto(linkText);
        await guestPage
            .getByLabel("Password")
            .locator("..")
            .getByRole("textbox")
            .fill(sharePassword);
        await guestPage.getByRole("button", { name: "View note" }).click();
        await expect(guestPage.locator("article")).toContainText(secret, { timeout: 30_000 });
        await guest.close();

        await page.goto(noteUrl);
        await waitForVaultUnlocked(page);
    });
});

// A share link wraps the note's own Item Key. Overwrite all used to re-key the note it
// replaced, so the recipient could no longer decrypt it while the owner still saw the link as active.
test.describe("Share link — survives an Overwrite all restore", () => {
    setupAuthenticatedUser();

    test("the recipient sees the restored content through the same link", async ({
        page,
        context,
    }) => {
        test.slow();
        const backedUp = `Backed up ${Date.now()}`;
        const noteUrl = await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.type(backedUp);
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Share" }).click();
        await page.getByRole("button", { name: "Create link" }).click();
        await expect(page.getByText("Link ready")).toBeVisible({ timeout: 15_000 });
        const linkText = await page.locator("p.font-mono").innerText();
        await page.keyboard.press("Escape");

        await waitForSyncIdle(page);
        const backupPath = await exportEncryptedBackup(page);

        await page.goto(noteUrl);
        await waitForVaultUnlocked(page);
        await editor.click();
        await editor.fill("Changed after the backup");
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: 15_000 });
        await waitForSyncIdle(page);

        await restoreBackup(page, backupPath, "overwrite");

        const guest = await context.browser()!.newContext();
        try {
            const guestPage = await guest.newPage();
            await guestPage.goto(linkText);
            await guestPage.getByRole("button", { name: "View note" }).click();
            await expect(guestPage.locator("article")).toContainText(backedUp, { timeout: 20_000 });
        } finally {
            await guest.close();
        }
    });
});
