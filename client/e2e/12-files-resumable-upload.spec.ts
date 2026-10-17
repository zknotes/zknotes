import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import {
    captureEmbedFileId,
    fileCard,
    LIFECYCLE_TIMEOUT,
    UPLOAD_TIMEOUT,
    uploadToNote,
} from "./helpers/files";

/**
 * Smoke — the resumable multipart pipeline (open session → lazy URL mint → finalize).
 * The detailed scenarios sit in the unit/integration layer; the E2E confirms the wire.
 */
test.describe("Files — resumable upload smoke", () => {
    setupAuthenticatedUser();

    test("an editor upload goes through open → urls → finalize and the file is READY", async ({
        page,
    }) => {
        const name = "e2e-resumable.txt";
        const buffer = Buffer.from(`resumable smoke ${Date.now()}`);

        await page.goto("/");
        await createNoteAndNavigate(page);

        const sessionPromise = page.waitForResponse(
            (res) => res.request().method() === "POST" && /\/uploads$/.test(res.url()) && res.ok(),
            { timeout: UPLOAD_TIMEOUT },
        );
        const urlsPromise = page.waitForResponse(
            (res) =>
                res.request().method() === "POST" &&
                /\/uploads\/[^/]+\/urls$/.test(res.url()) &&
                res.ok(),
            { timeout: UPLOAD_TIMEOUT },
        );
        const finalizePromise = page.waitForResponse(
            (res) =>
                res.request().method() === "POST" &&
                /\/uploads\/[^/]+\/finalize$/.test(res.url()) &&
                res.ok(),
            { timeout: UPLOAD_TIMEOUT },
        );

        await uploadToNote(page, name, "text/plain", buffer);

        const [sessionRes, urlsRes, finalizeRes] = await Promise.all([
            sessionPromise,
            urlsPromise,
            finalizePromise,
        ]);

        const sessionBody = (await sessionRes.json()) as { chunk_set_id?: string };
        expect(sessionBody.chunk_set_id).toBeTruthy();

        const finalizeUrl = finalizeRes.url();
        const chunkSetId = finalizeUrl.match(/\/uploads\/([^/]+)\/finalize/)?.[1];
        expect(chunkSetId).toBe(sessionBody.chunk_set_id);

        const urlsBody = (await urlsRes.json()) as { urls?: unknown[] };
        expect(urlsBody.urls?.length).toBeGreaterThan(0);

        const fileId = await captureEmbedFileId(page);
        expect(fileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

        await page.goto("/files");
        await expect(fileCard(page, name)).toBeVisible({ timeout: LIFECYCLE_TIMEOUT });
    });
});
