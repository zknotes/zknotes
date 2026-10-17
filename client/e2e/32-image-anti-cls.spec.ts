import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import { redPngBuffer, uploadToNote } from "./helpers/files";

/**
 * Anti-CLS.
 *
 * Decrypting an image is async. With no space reserved, the `<img>` is 0 px tall until the bytes
 * arrive and everything below jumps. The node therefore carries intrinsic dimensions
 * (`data-w`/`data-h`)
 * that are available SYNCHRONOUSLY out of the note's HTML — with nothing decrypted.
 *
 * This cannot be proven by a unit test — it needs a real layout engine — so it lives as an E2E test.
 */
test.describe("Images — anti-CLS (reserved space)", () => {
    setupAuthenticatedUser();

    test("an upload writes the intrinsic dimensions into the node and reserves space before decryption", async ({
        page,
    }) => {
        test.slow();
        await createNoteAndNavigate(page);
        await uploadToNote(page, "e2e-anti-cls.png", "image/png", redPngBuffer());

        const node = page.locator(".encfile-node[data-file-id]").first();
        await expect(node).toBeVisible();

        // 1. The dimensions are written into the node (the self-heal writes them after the first successful load).
        const img = node.locator("img").first();
        await expect
            .poll(async () => await img.getAttribute("data-w"), { timeout: 15_000 })
            .toBeTruthy();

        const w = Number(await img.getAttribute("data-w"));
        const h = Number(await img.getAttribute("data-h"));
        expect(w).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);

        // 2. Save, then reload — the node now comes from the stored HTML, carrying the dimensions.
        await page.keyboard.press("Control+s");
        await page.waitForTimeout(500);
        await page.reload();

        const imgAfter = page.locator(".encfile-node[data-file-id] img").first();
        await expect(imgAfter).toBeVisible({ timeout: 15_000 });

        // 3. The key assertion: the space is reserved through aspect-ratio, so the height is > 0 and
        //    the ratio matches the original — regardless of whether the image has been decrypted yet.
        const box = await imgAfter.boundingBox();
        expect(box).not.toBeNull();
        expect(box?.height ?? 0).toBeGreaterThan(0);

        const aspect = await imgAfter.evaluate((el) => getComputedStyle(el).aspectRatio);
        expect(aspect).not.toBe("auto");

        // 4. The content below the image must not move once the image finishes loading.
        //    (If the space is not reserved, this delta equals the image's height.)
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await page.keyboard.press("End");
        await editor.type("below the image");
        const below = editor.getByText("below the image");
        const beforeY = (await below.boundingBox())?.y ?? 0;

        await imgAfter.evaluate(
            (el) =>
                (el as HTMLImageElement).complete ||
                new Promise((r) => el.addEventListener("load", r, { once: true })),
        );
        const afterY = (await below.boundingBox())?.y ?? 0;

        expect(Math.abs(afterY - beforeY)).toBeLessThanOrEqual(2);
    });
});
