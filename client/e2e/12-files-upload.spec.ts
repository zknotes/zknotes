import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FILE_LIMITS } from "@zknotes/shared";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

// Smoke — the Toast wiring on the editor path (NoteFileEvents.sizeErrorMsg). The size-guard logic:
// editor-images.test.ts and limits.test.ts. The E2E confirms the network never sees /uploads for an oversized file.

test.describe("Files — upload size limit (editor path)", () => {
    setupAuthenticatedUser();

    test("a file above the limit shows a clear error and does NOT start an upload", async ({
        page,
    }) => {
        // A large file (the limit plus 1 B) — Playwright cannot transfer a >50 MB buffer, so we write a
        // sparse file to disk and hand over its path. test.slow() triples the timeout (a 50+ MB
        // transfer).
        test.slow();

        const overLimit = FILE_LIMITS.MAX_FILE_SIZE + 1;
        const expectedMaxMB = Math.floor(FILE_LIMITS.MAX_FILE_SIZE / (1024 * 1024));

        // A sparse fixture: created instantly, ~0 on disk; setInputFiles sees the full size (the sparse part is zeros).
        const dir = mkdtempSync(join(tmpdir(), "cn-e2e-"));
        const bigPath = join(dir, "too-big.bin");
        writeFileSync(bigPath, "");
        truncateSync(bigPath, overLimit);

        try {
            // Track whether any upload waypoint reached the network (the POST /uploads init).
            let uploadStarted = false;
            page.on("request", (req) => {
                if (/\/uploads(\/|$)/.test(req.url())) uploadStarted = true;
            });

            await createNoteAndNavigate(page);
            await page.locator('.ProseMirror[contenteditable="true"]').click();

            // A non-image over the limit → the size check refuses it before the image/confirm branching
            // (editor-images.ts). We pass a path rather than a buffer (CDP's >50 MB limit).
            await page.setInputFiles('input[type="file"]', bigPath);

            // A visible error from NoteFileEvents (a Toast, auto-clearing after 5 s) — it carries the limit in MB.
            await expect(
                page.getByText(new RegExp(`is too large — max ${expectedMaxMB} MB`)),
            ).toBeVisible({ timeout: 15_000 });

            // The negative assertion: the upload never started. Deterministic — the size check in
            // handleEditorFiles dispatches tooLarge and `continue`s SYNCHRONOUSLY before any async
            // the upload, so once the Toast is visible, no upload has been requested for this file, and none will be.
            expect(uploadStarted).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
