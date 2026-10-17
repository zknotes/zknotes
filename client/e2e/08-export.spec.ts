import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import {
    createNoteAndNavigate,
    dismissBreadcrumbAutoRename,
    renameActiveNoteViaBreadcrumb,
    waitForVaultUnlocked,
} from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import { continuePastDownloadNotice, waitForSyncIdle } from "./helpers/backup";
import { fileCard, UPLOAD_TIMEOUT, uploadToNote } from "./helpers/files";

/**
 * A thin UI smoke — an encrypted backup overwrite (the worker + the Settings wiring).
 * The matrix (folders, multi-chunk, unicode, version>1…) lives in
 * full-backup-roundtrip.integration.test.ts — here only one note + a small file.
 */
test.describe("Data Export — encrypted backup smoke", () => {
    setupAuthenticatedUser();

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            delete (window as any).showSaveFilePicker;
        });
    });

    test("encrypted backup round-trips note + file without decrypt errors", async ({ page }) => {
        const decryptErrors: string[] = [];
        page.on("console", (msg) => {
            const text = msg.text();
            if (/invalid tag|Failed to decrypt|Encrypted\.\.\./i.test(text)) {
                decryptErrors.push(text);
            }
        });

        const noteUrl = await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.fill("Roundtrip Content");
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        // A small text file — it exercises the file restore path (key reuse / version) without a heavy upload.
        const fileName = "backup-smoke.txt";
        await uploadToNote(page, fileName, "text/plain", Buffer.from("backup smoke bytes"));
        await page.goto("/files");
        await expect(fileCard(page, fileName)).toBeVisible({ timeout: UPLOAD_TIMEOUT });

        await page.goto("/settings");
        await page.getByRole("link", { name: "Backup" }).click();
        await expect(page.locator("h1", { hasText: "Backup" })).toBeVisible();

        await page.getByRole("button", { name: "Create Encrypted Backup" }).click();
        const BACKUP_PASS = "backup-pass-1234";
        await page.getByPlaceholder("Backup passphrase").fill(BACKUP_PASS);
        await page.getByPlaceholder("Confirm passphrase").fill(BACKUP_PASS);

        const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
        await page.getByRole("button", { name: "Create encrypted backup" }).click();
        await continuePastDownloadNotice(page, downloadPromise, "Download and back up");
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toContain(".cnbackup");
        const backupPath = await download.path();
        expect(backupPath).toBeTruthy();

        // A restore refuses to start while this device has changes the server has not seen yet
        // (they would be lost); under load the upload can still be syncing at this point.
        await waitForSyncIdle(page);
        await page.locator('input[type="file"]').setInputFiles(backupPath!);
        await page.getByPlaceholder("Backup passphrase").fill(BACKUP_PASS);
        await page.getByRole("button", { name: "Unlock" }).click();
        await page.getByText("Overwrite all", { exact: false }).click();
        await page.getByRole("button", { name: "Start restore" }).click();
        await page.getByRole("button", { name: "Confirm restore" }).click();
        await expect(page.getByTestId("restore-complete")).toBeVisible({ timeout: 60_000 });

        await page.goto(noteUrl);
        await waitForVaultUnlocked(page);
        await expect(editor).toContainText("Roundtrip Content", { timeout: 15_000 });

        await page.goto("/files");
        await expect(fileCard(page, fileName)).toBeVisible({ timeout: 15_000 });
        // No placeholder from a failed decrypt may be left behind.
        await expect(page.getByText("Encrypted...")).toHaveCount(0);

        expect(decryptErrors, decryptErrors.join("\n")).toHaveLength(0);
    });
});

/** Empties this device's cache of file chunks — the files stay on the server only. */
async function clearLocalChunks(page: Page): Promise<void> {
    await page.evaluate(
        () =>
            new Promise<void>((resolve, reject) => {
                const open = indexedDB.open("zknotes-v1");
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction("file-chunks", "readwrite");
                    tx.objectStore("file-chunks").clear();
                    tx.oncomplete = () => {
                        db.close();
                        resolve();
                    };
                    tx.onerror = () => reject(tx.error);
                };
            }),
    );
}

// An export used to leave out every attachment the device's auto-download policy had not
// fetched. It now downloads them, and says so before the save dialog opens.
test.describe("Data Export — attachments this device does not have", () => {
    setupAuthenticatedUser();

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            delete (window as any).showSaveFilePicker;
            // The phone default: nothing is fetched just for viewing, so the export has to ask
            // (a desktop's "always" downloads without asking).
            localStorage.setItem(
                "zknotes:sync-settings",
                JSON.stringify({ autoDownload: "never" }),
            );
        });
    });

    test("the export asks first, Cancel starts nothing, and continuing includes the file", async ({
        page,
    }) => {
        await createNoteAndNavigate(page);
        const fileName = "not-here.txt";
        const content = "fetched from the server for the export";
        await uploadToNote(page, fileName, "text/plain", Buffer.from(content));
        await page.goto("/files");
        await expect(fileCard(page, fileName)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
        await clearLocalChunks(page);

        await page.goto("/settings");
        await page.getByRole("link", { name: "Backup" }).click();
        const card = page.getByTestId("export-html");
        const downloads: string[] = [];
        page.on("download", (d) => downloads.push(d.suggestedFilename()));

        await card.getByRole("button", { name: "Export as HTML" }).click();
        const notice = card.getByTestId("export-download-notice");
        await expect(notice).toContainText("1 file is not on this device");
        await notice.getByRole("button", { name: "Cancel" }).click();
        await expect(notice).toBeHidden();
        await expect(card.getByRole("button", { name: "Export as HTML" })).toBeEnabled();
        expect(downloads).toHaveLength(0);

        const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
        await card.getByRole("button", { name: "Export as HTML" }).click();
        await notice.getByRole("button", { name: "Download and export" }).click();
        const download = await downloadPromise;
        const zip = unzipSync(new Uint8Array(await readFile((await download.path())!)));
        const attachment = Object.keys(zip).find(
            (path) => path.startsWith("_attachments/") && path.endsWith(`/${fileName}`),
        );
        expect(attachment, Object.keys(zip).join("\n")).toBeTruthy();
        expect(strFromU8(zip[attachment!]!)).toBe(content);
        await expect(card.getByTestId("export-skipped")).toHaveCount(0);

        // The export read the file without caching it, so the backup has to ask again.
        const backupCard = page.getByTestId("backup-create");
        await backupCard.getByRole("button", { name: "Create Encrypted Backup" }).click();
        await backupCard.getByPlaceholder("Backup passphrase").fill("backup-pass-1234");
        await backupCard.getByPlaceholder("Confirm passphrase").fill("backup-pass-1234");
        const backupDownload = page.waitForEvent("download", { timeout: 30_000 });
        await backupCard.getByRole("button", { name: "Create encrypted backup" }).click();
        const backupNotice = backupCard.getByTestId("export-download-notice");
        await expect(backupNotice).toContainText("1 file is not on this device");
        await backupNotice.getByRole("button", { name: "Download and back up" }).click();
        expect((await backupDownload).suggestedFilename()).toContain(".cnbackup");
        await expect(backupCard.getByTestId("export-skipped")).toHaveCount(0);
    });
});

test.describe("Data Export — Markdown", () => {
    setupAuthenticatedUser();

    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            delete (window as any).showSaveFilePicker;
        });
    });

    test("exports a note as a Markdown file named after it", async ({ page }) => {
        await createNoteAndNavigate(page);
        await dismissBreadcrumbAutoRename(page);
        await renameActiveNoteViaBreadcrumb(page, "Markdown note");
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.fill("Body of the Markdown note");
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        await page.goto("/settings");
        await page.getByRole("link", { name: "Backup" }).click();
        const card = page.getByTestId("export-html");
        const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
        await card.getByRole("button", { name: "Export as Markdown" }).click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/^zknotes-markdown-.*\.zip$/);

        const zip = unzipSync(new Uint8Array(await readFile((await download.path())!)));
        const markdown = zip["Markdown note.md"];
        expect(markdown, Object.keys(zip).join("\n")).toBeTruthy();
        const text = strFromU8(markdown!);
        expect(text.startsWith("# Markdown note")).toBe(true);
        expect(text).toContain("Body of the Markdown note");
    });
});
