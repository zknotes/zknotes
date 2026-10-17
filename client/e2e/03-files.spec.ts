import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import {
    fileCard,
    LIFECYCLE_TIMEOUT,
    moveToTrashFromFilePanel,
    redPngBuffer,
    uploadDocToFiles,
    uploadToNote,
} from "./helpers/files";

/**
 * Smoke — upload wiring, CropModal UI, storage bar trash link.
 * The trash/restore/permanent logic lives in file-service.integration.test.ts + file-lifecycle.test.ts.
 */
test.describe("Files — smoke (upload / crop / storage bar)", () => {
    setupAuthenticatedUser();

    test("upload → the file appears in All Files (Active)", async ({ page }) => {
        await uploadDocToFiles(page, "e2e-upload.txt");
    });

    test("uploading a single image through the editor → the file is present in /files", async ({
        page,
    }) => {
        const name = "e2e-image.png";
        await page.goto("/");
        await createNoteAndNavigate(page);
        await uploadToNote(page, name, "image/png", redPngBuffer());
        await page.goto("/files");
        await expect(fileCard(page, name)).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
    });

    test("storage bar shows usage and trash link after delete", async ({ page }) => {
        await page.goto("/files");
        await expect(page.getByText(/0 (B|KB) \/ 1.0 GB used/)).toBeVisible();

        const fileName = "trash-quota-test.txt";
        await uploadDocToFiles(page, fileName, "text/plain", Buffer.alloc(2048, "a"));

        await expect(page.locator("text=/used/")).not.toHaveText(/0 (B|KB) \/ 1\.0 GB used/, {
            timeout: 10_000,
        });

        await fileCard(page, fileName).click();
        await moveToTrashFromFilePanel(page);

        await expect(page.locator("text=/in trash/i")).toBeVisible({ timeout: 5_000 });
        await page.locator("text=/in trash/i").click();
        await expect(page.getByRole("button", { name: /Empty trash/i })).toBeVisible({
            timeout: 5_000,
        });
    });
});
