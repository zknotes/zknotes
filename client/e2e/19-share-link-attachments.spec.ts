import { expect, test } from "@playwright/test";
import {
    createNoteAndNavigate,
    e2ePassword,
    registerUser,
    uniqueEmail,
    waitForVaultUnlocked,
} from "./helpers/auth";
import { redPngBuffer, UPLOAD_TIMEOUT, uploadToNote } from "./helpers/files";

test.describe("Share link — image attachments", () => {
    test("include attachments → guest sees inline image", async ({ page, context }) => {
        test.slow();

        const email = uniqueEmail();
        const password = e2ePassword();
        await registerUser(page, email, password);

        const noteUrl = await createNoteAndNavigate(page);
        await uploadToNote(page, "e2e-share-img.png", "image/png", redPngBuffer());
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: 15_000 });

        await page.getByRole("button", { name: "Share" }).click();
        const createNew = page.getByRole("button", { name: "Create new link" });
        if (await createNew.isVisible().catch(() => false)) {
            await createNew.click();
        }

        const attachCheckbox = page.getByRole("checkbox", { name: /Include attachments/i });
        await expect(attachCheckbox).toBeEnabled({ timeout: 10_000 });
        await attachCheckbox.check();

        await page.getByRole("button", { name: /Create link|Replace link/ }).click();
        await expect(page.getByText("Link ready")).toBeVisible({ timeout: 30_000 });

        const linkText = await page.locator("p.font-mono").innerText();
        expect(linkText).toContain("/s/");
        expect(linkText).toContain("#k=");

        const guest = await context.browser()!.newContext();
        const guestPage = await guest.newPage();
        await guestPage.goto(linkText);
        await guestPage.getByRole("button", { name: "View note" }).click();

        const article = guestPage.locator(".share-note-content");
        await expect(article).not.toContainText("not included in this share link", {
            timeout: 30_000,
        });
        const img = article.locator("img");
        await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
        await expect
            .poll(async () => img.getAttribute("src"), { timeout: UPLOAD_TIMEOUT })
            .toMatch(/^blob:/);
        await expect(guestPage.getByRole("heading", { name: "Attachments" })).not.toBeVisible();

        // The note body is the sharer's HTML and keeps its classes: an element styled to cover
        // the whole page must stay inside the note, below the page heading.
        const covered = await guestPage.evaluate(() => {
            const content = document.querySelector(".share-note-content");
            const heading = document.querySelector("h1");
            if (!content || !heading) return "missing";
            const overlay = document.createElement("a");
            overlay.className = "fixed inset-0 z-50";
            overlay.textContent = "overlay";
            content.appendChild(overlay);
            const box = heading.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            overlay.remove();
            return hit === overlay ? "covered" : "clear";
        });
        expect(covered).toBe("clear");

        await guest.close();

        await page.goto(noteUrl);
        await waitForVaultUnlocked(page);
    });
});
