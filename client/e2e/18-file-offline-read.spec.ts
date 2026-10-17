import { expect, test } from "@playwright/test";
import {
    createNoteAndNavigate,
    registerUser,
    uniqueEmail,
    waitForVaultUnlocked,
} from "./helpers/auth";
import { captureEmbedFileId, redPngBuffer, UPLOAD_TIMEOUT } from "./helpers/files";

const PASSWORD = "correct-horse-battery-staple";

/**
 * Smoke — an image survives a reload and is served out of the local chunk cache (no chunk GET on the
 * network). The presence-badge logic is in presence.test.ts + chunk-loader.integration.test.ts.
 */
test.describe("Files — offline read smoke", () => {
    test("uploaded image survives reload and is served from local cache (no chunk network)", async ({
        page,
    }) => {
        test.slow();
        await registerUser(page, uniqueEmail(), PASSWORD);
        await waitForVaultUnlocked(page);
        await createNoteAndNavigate(page);

        await page.locator('.ProseMirror[contenteditable="true"]').click();
        await page.setInputFiles('input[type="file"]', {
            name: "offline.png",
            mimeType: "image/png",
            buffer: redPngBuffer(),
        });
        await expect(page.locator(".encfile-node")).toBeVisible({ timeout: UPLOAD_TIMEOUT });
        await captureEmbedFileId(page);
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        // Block the chunk GETs — if the image still appears, it has to be coming from the local cache.
        await page.route(/\/uploads\/[^/]+\/chunks\/\d+/, (route) => {
            if (route.request().method() === "GET") {
                void route.abort("failed");
            } else {
                void route.continue();
            }
        });

        await page.reload();
        await waitForVaultUnlocked(page);

        const img = page.locator(".encfile-node img");
        await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
        await expect(img).toHaveAttribute("src", /^blob:/);
    });
});
