import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
    breadcrumbRenameInput,
    createNoteAndNavigate,
    e2ePassword,
    registerUser,
    uniqueEmail,
    waitForVaultUnlocked,
} from "./helpers/auth";
import {
    buildReferenceWorkspace,
    createNamedFolder,
    deleteForeverFromTrash,
    E2E_BACKUP_PASSPHRASE,
    emptyTrash,
    exportEncryptedBackup,
    fetchStorage,
    openColdContext,
    orderIds,
    REF,
    restoreBackup,
    snapshotTree,
    snapshotWorkspace,
    trashItemByTitle,
    type WorkspaceSnapshot,
    waitForSyncIdle,
} from "./helpers/backup";
import { fileCard, openFileDetailPanel, UPLOAD_TIMEOUT, uploadToNote } from "./helpers/files";

/**
 * The full lifecycle of a backup and a restore over a REFERENCE workspace.
 *
 * The existing `08-export.spec.ts` is deliberately a thin smoke test (one note plus a small file).
 * This spec covers what the smoke test misses: a restore that *looks* successful while the items
 * are not on the server, are in the wrong folder, or in the wrong order.
 *
 * The rule: every assertion about a restore's result is read from a **fresh browser context** that
 * pulled its data from the server. A `page.reload()` is not a cold start — the SharedWorker and the sessionStorage
 * `vault_key` survive a reload. The only exception is the import-diagnostics test, which inspects the
 * client that did the import.
 *
 * `setupAuthenticatedUser()` is deliberately not used: that helper registers in a beforeEach, and
 * fullyParallel: true would give every test an empty vault. Each scenario has its own context,
 * its own account and mode: "serial".
 *
 * THE REFERENCE WORKSPACE (built by `buildReferenceWorkspace`):
 *   Folder A
 *     ├─ Folder A/B  (nested — it catches depth > 1)
 *     │    └─ Note A-B-1   (a note inside the nested folder)
 *     ├─ Note A-1         (a note with an attachment)
 *     └─ Note A-2         (a note with an inline image → an encFile node)
 *   Folder C             (deliberately EMPTY — an empty folder has to survive the restore)
 *   Note ROOT-1          (a note at the root, with no parent)
 *
 * The notes are created BEFORE their folders and then moved inside — the UUIDv7 order
 * deliberately does not follow the hierarchy.
 */

const PASSWORD = e2ePassword();

async function closeQuietly(ctx?: BrowserContext): Promise<void> {
    if (!ctx) return;
    await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 3_000))]).catch(() => {});
}

async function newScenarioPage(browser: Browser): Promise<{
    context: BrowserContext;
    page: Page;
    email: string;
}> {
    // Its own context per scenario — the default context would share IndexedDB/the SharedWorker if
    // A/B/C happened to land on the same worker.
    const context = await browser.newContext();
    await context.addInitScript(() => {
        delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const page = await context.newPage();
    const email = uniqueEmail();
    await registerUser(page, email, PASSWORD);
    await waitForSyncIdle(page);
    return { context, page, email };
}

test.describe("A — a restore on a cold device", () => {
    test.describe.configure({ mode: "serial", timeout: 240_000 });

    let sourceContext: BrowserContext;
    let sourcePage: Page;
    let destContext: BrowserContext;
    let destPage: Page;
    let destEmail: string;
    let cold: { context: BrowserContext; page: Page } | undefined;
    let backupPath: string;
    let baseline: WorkspaceSnapshot;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(180_000);
        const source = await newScenarioPage(browser);
        sourceContext = source.context;
        sourcePage = source.page;
    });

    test.afterAll(async () => {
        await closeQuietly(cold?.context);
        await closeQuietly(destContext);
        await closeQuietly(sourceContext);
    });

    test("builds the reference workspace, records the baseline and exports a backup", async () => {
        test.slow();
        await buildReferenceWorkspace(sourcePage);
        await waitForSyncIdle(sourcePage);
        await expect
            .poll(async () => (await fetchStorage(sourcePage)).files_bytes, { timeout: 60_000 })
            .toBeGreaterThan(0);

        baseline = await snapshotWorkspace(sourcePage);
        expect(
            baseline.storage.items_bytes,
            "items_bytes baseline must be non-zero",
        ).toBeGreaterThan(0);
        expect(
            baseline.storage.files_bytes,
            "files_bytes baseline must be non-zero",
        ).toBeGreaterThan(0);
        expect(baseline.tree.some((t) => t.title === REF.folderC)).toBe(true);
        expect(baseline.files.length).toBeGreaterThanOrEqual(2);

        backupPath = await exportEncryptedBackup(sourcePage, E2E_BACKUP_PASSPHRASE);
        expect(backupPath).toBeTruthy();

        // An item `id` is a global PK. The source account still holds those IDs, so a restore into a
        // different account in the same database would fail on a unique violation — which is not the
        // "fresh second account" scenario. Deleting the source frees the IDs (ON DELETE CASCADE).
        await sourcePage.goto("/settings/delete-account");
        await sourcePage.getByRole("button", { name: /Delete vault/ }).click();
        await sourcePage.getByPlaceholder("Enter your password to confirm").fill(PASSWORD);
        await sourcePage.locator("#delete-confirm").fill("DELETE");
        await sourcePage.getByRole("button", { name: /Permanently delete vault/ }).click();
        await sourcePage.waitForURL(/\/login/, { timeout: 30_000 });
    });

    test("the import reports success on the client (DIAGNOSTICS, not proof)", async ({
        browser,
    }) => {
        test.slow();
        destEmail = uniqueEmail();
        destContext = await browser.newContext();
        await destContext.addInitScript(() => {
            delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
        });
        destPage = await destContext.newPage();
        await registerUser(destPage, destEmail, PASSWORD);
        await waitForSyncIdle(destPage);

        await restoreBackup(destPage, backupPath, "overwrite");
        await destPage.goto("/");
        await waitForSyncIdle(destPage, 120_000);

        const local = await snapshotTree(destPage);
        expect(local).toHaveLength(baseline.tree.length);
        expect(new Set(local.map((t) => t.id))).toEqual(new Set(baseline.tree.map((t) => t.id)));
        expect(local.some((t) => t.title === REF.folderC)).toBe(true);

        // Waiting for the file upload to reach the SERVER (the quota), not the local /files (the local cache).
        await expect
            .poll(async () => (await fetchStorage(destPage)).files_bytes, { timeout: 90_000 })
            .toBeGreaterThan(0);
    });

    test("the restored items survive a cold start", async ({ browser }) => {
        test.slow();
        cold = await openColdContext(browser, destEmail, PASSWORD);
        const tree = await snapshotTree(cold.page);
        expect(tree).toHaveLength(baseline.tree.length);
        for (const item of baseline.tree) {
            const found = tree.find((t) => t.id === item.id);
            expect(found, `missing ${item.title} (${item.id})`).toBeTruthy();
            expect(found?.parentId, item.title).toBe(item.parentId);
        }
    });

    test("the restore preserves the order within each parent", async () => {
        if (!cold) throw new Error("cold context missing — the cold-start test must run first");
        const tree = await snapshotTree(cold.page);
        const folderA = baseline.tree.find((t) => t.title === REF.folderA);
        const folderAB = baseline.tree.find((t) => t.title === REF.folderAB);
        expect(folderA && folderAB).toBeTruthy();

        for (const parentId of [null, folderA!.id, folderAB!.id]) {
            expect(orderIds(tree, parentId), `order under ${parentId ?? "root"}`).toEqual(
                orderIds(baseline.tree, parentId),
            );
        }
    });

    test("the restored attachment is byte-identical, and the inline image renders", async () => {
        if (!cold) throw new Error("cold context missing — the cold-start test must run first");
        const decryptErrors: string[] = [];
        cold.page.on("console", (msg) => {
            const text = msg.text();
            if (/invalid tag|Failed to decrypt|Encrypted\.\.\./i.test(text)) {
                decryptErrors.push(text);
            }
        });

        const attach = baseline.files.find((f) => f.name === REF.attachName);
        expect(attach, "baseline missing attachment").toBeTruthy();

        await cold.page.goto("/files");
        await expect(fileCard(cold.page, REF.attachName)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
        await openFileDetailPanel(cold.page, REF.attachName);
        const [download] = await Promise.all([
            cold.page.waitForEvent("download", { timeout: 30_000 }),
            cold.page.getByRole("button", { name: "Save a copy" }).click(),
        ]);
        const path = await download.path();
        expect(path).toBeTruthy();
        const buf = await readFile(path!);
        expect(createHash("sha256").update(buf).digest("hex")).toBe(attach!.sha256);

        const noteA2 = baseline.tree.find((t) => t.title === REF.noteA2);
        expect(noteA2).toBeTruthy();
        await cold.page.goto(`/note/${noteA2!.id}`);
        await expect(cold.page.locator(".encfile-node[data-file-id]").first()).toBeVisible({
            timeout: 30_000,
        });
        await expect(cold.page.getByText("Encrypted...")).toHaveCount(0);
        expect(decryptErrors, decryptErrors.join("\n")).toHaveLength(0);
    });

    test("usage after the restore matches the baseline, category by category", async () => {
        if (!cold) throw new Error("cold context missing — the cold-start test must run first");
        await expect
            .poll(
                async () => {
                    const s = await fetchStorage(cold!.page);
                    return {
                        files_bytes: s.files_bytes,
                        trashed_bytes: s.trashed_bytes,
                        history_bytes: s.history_bytes,
                        items_bytes: s.items_bytes,
                    };
                },
                { timeout: 30_000 },
            )
            .toEqual({
                files_bytes: baseline.storage.files_bytes,
                trashed_bytes: 0,
                // item_history is not part of a backup, so a restore into a fresh account has no
                // history.
                history_bytes: 0,
                // XChaCha20 does not change the plaintext's length (files_bytes above already
                // proves it) — a backup and the import have to write the same set of NotePayload
                // fields, contentTitle included.
                items_bytes: baseline.storage.items_bytes,
            });
    });
});

test.describe("B — a purged id", () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    let context: BrowserContext;
    let page: Page;
    let email: string;
    let backupPath: string;
    const noteTitle = "Purge Target";

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120_000);
        const s = await newScenarioPage(browser);
        context = s.context;
        page = s.page;
        email = s.email;
    });

    test.afterAll(async () => {
        await closeQuietly(context);
    });

    test("restoring a note the server purged brings the content back under a new ID", async () => {
        await createNoteAndNavigate(page);
        const input = breadcrumbRenameInput(page);
        await input.waitFor({ state: "visible", timeout: 10_000 });
        await input.fill(noteTitle);
        await input.press("Enter");
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.fill("purge-me body");
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });
        await expect(
            page.locator('[data-node-type="note"]').filter({ hasText: noteTitle }),
        ).toBeVisible();

        await waitForSyncIdle(page);
        backupPath = await exportEncryptedBackup(page, E2E_BACKUP_PASSPHRASE);

        await trashItemByTitle(page, "note", noteTitle);
        await deleteForeverFromTrash(page, noteTitle);
        await page.goto("/");
        try {
            await waitForSyncIdle(page);
        } catch {
            await page.getByTestId("sync-status").click();
            await page.getByRole("button", { name: /Sync now/i }).click({ timeout: 5_000 });
            await waitForSyncIdle(page);
        }

        await restoreBackup(page, backupPath, "overwrite");
        await page.goto("/");
        await waitForSyncIdle(page, 120_000);

        // The purged ID is remapped — the content is in the tree under a new identity, not in the
        // conflict inbox.
        const row = page.locator('[data-node-type="note"]').filter({ hasText: noteTitle });
        await expect(row).toBeVisible({ timeout: 30_000 });
        await row.click();
        await expect(page.locator(".ProseMirror")).toContainText("purge-me body", {
            timeout: 15_000,
        });
    });

    test("the resurrected content is on the server, not only local", async ({ browser }) => {
        const purgeErrors: string[] = [];
        const cold = await openColdContext(browser, email, PASSWORD);
        cold.page.on("console", (msg) => {
            if (msg.text().includes("Item is permanently deleted")) purgeErrors.push(msg.text());
        });
        try {
            await waitForSyncIdle(cold.page);
            const row = cold.page.locator('[data-node-type="note"]').filter({ hasText: noteTitle });
            await expect(row).toBeVisible({ timeout: 30_000 });
            await row.click();
            await expect(cold.page.locator(".ProseMirror")).toContainText("purge-me body", {
                timeout: 15_000,
            });
            expect(purgeErrors, purgeErrors.join("\n")).toHaveLength(0);
        } finally {
            await cold.context.close();
        }
    });
});

test.describe("C — the quota after an Empty Trash", () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    let context: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
        test.setTimeout(120_000);
        const s = await newScenarioPage(browser);
        context = s.context;
        page = s.page;
    });

    test.afterAll(async () => {
        await closeQuietly(context);
    });

    test("deleting everything plus Empty Trash drops all four categories to zero and empties the UI", async () => {
        await createNoteAndNavigate(page);
        const input = breadcrumbRenameInput(page);
        await input.waitFor({ state: "visible", timeout: 10_000 });
        await input.fill("C1 Note");
        await input.press("Enter");
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.fill("c1 body");
        await uploadToNote(page, "c1-doc.txt", "text/plain", Buffer.from("c1-file-bytes"));
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        await createNamedFolder(page, "C1 Folder");
        await waitForSyncIdle(page);
        await expect
            .poll(
                async () => {
                    const s = await fetchStorage(page);
                    return s.files_bytes + s.items_bytes;
                },
                { timeout: 60_000 },
            )
            .toBeGreaterThan(0);

        await trashItemByTitle(page, "folder", "C1 Folder");
        await trashItemByTitle(page, "note", "C1 Note");
        await emptyTrash(page);
        await waitForSyncIdle(page);

        await expect
            .poll(
                async () => {
                    const s = await fetchStorage(page);
                    return {
                        items_bytes: s.items_bytes,
                        files_bytes: s.files_bytes,
                        history_bytes: s.history_bytes,
                        trashed_bytes: s.trashed_bytes,
                    };
                },
                { timeout: 60_000 },
            )
            .toEqual({
                items_bytes: 0,
                files_bytes: 0,
                history_bytes: 0,
                trashed_bytes: 0,
            });

        await page.goto("/");
        await expect(page.getByText("your vault is empty")).toBeVisible({ timeout: 15_000 });
        await page.goto("/files");
        await expect(page.getByText("No files yet")).toBeVisible({ timeout: 15_000 });
    });
});

test.describe("D — an interrupted restore", () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test("a tab refresh offers to continue with the same file", async ({ browser }) => {
        test.slow();
        const s = await newScenarioPage(browser);
        try {
            await createNamedNoteWithBody(s.page, "Interrupted restore note");
            await waitForSyncIdle(s.page);
            const backupPath = await exportEncryptedBackup(s.page, E2E_BACKUP_PASSPHRASE);

            await s.page.goto("/settings");
            await s.page.getByRole("link", { name: "Backup" }).click();
            await s.page
                .locator('input[type="file"][accept*="cnbackup"]')
                .setInputFiles(backupPath);
            await s.page.getByPlaceholder("Backup passphrase").fill(E2E_BACKUP_PASSPHRASE);
            await s.page.getByRole("button", { name: "Unlock" }).click();
            await s.page.getByText("Overwrite all", { exact: false }).click();
            await s.page.getByRole("button", { name: "Start restore" }).click();
            await expect(s.page.getByRole("button", { name: "Confirm restore" })).toBeVisible({
                timeout: 30_000,
            });

            await s.page.reload();
            await waitForVaultUnlocked(s.page);
            await s.page.goto("/settings");
            await s.page.getByRole("link", { name: "Backup" }).click();
            await expect(s.page.getByTestId("restore-continue")).toBeVisible({ timeout: 15_000 });
            await s.page
                .locator('input[type="file"][accept*="cnbackup"]')
                .setInputFiles(backupPath);
            await s.page.getByPlaceholder("Backup passphrase").fill(E2E_BACKUP_PASSPHRASE);
            await s.page.getByRole("button", { name: "Unlock" }).click();
            await s.page.getByRole("button", { name: "Confirm restore" }).click();
            await expect(s.page.getByTestId("restore-complete")).toBeVisible({ timeout: 120_000 });
        } finally {
            await closeQuietly(s.context);
        }
    });

    test("the wrong file is refused on the hash", async ({ browser }) => {
        test.slow();
        const s = await newScenarioPage(browser);
        try {
            await createNamedNoteWithBody(s.page, "Original note");
            await waitForSyncIdle(s.page);
            const first = await exportEncryptedBackup(s.page, E2E_BACKUP_PASSPHRASE);
            await createNamedNoteWithBody(s.page, "Extra note");
            await waitForSyncIdle(s.page);
            const second = await exportEncryptedBackup(s.page, E2E_BACKUP_PASSPHRASE);

            await s.page.goto("/settings");
            await s.page.getByRole("link", { name: "Backup" }).click();
            await s.page.locator('input[type="file"][accept*="cnbackup"]').setInputFiles(first);
            await s.page.getByPlaceholder("Backup passphrase").fill(E2E_BACKUP_PASSPHRASE);
            await s.page.getByRole("button", { name: "Unlock" }).click();
            await s.page.getByText("Overwrite all", { exact: false }).click();
            await s.page.getByRole("button", { name: "Start restore" }).click();
            await expect(s.page.getByRole("button", { name: "Confirm restore" })).toBeVisible({
                timeout: 30_000,
            });

            await s.page.reload();
            await waitForVaultUnlocked(s.page);
            await s.page.goto("/settings");
            await s.page.getByRole("link", { name: "Backup" }).click();
            await expect(s.page.getByTestId("restore-continue")).toBeVisible({ timeout: 15_000 });
            await s.page.locator('input[type="file"][accept*="cnbackup"]').setInputFiles(second);
            await s.page.getByPlaceholder("Backup passphrase").fill(E2E_BACKUP_PASSPHRASE);
            await s.page.getByRole("button", { name: "Unlock" }).click();
            await expect(s.page.getByTestId("restore-wrong-file")).toBeVisible({ timeout: 30_000 });
        } finally {
            await closeQuietly(s.context);
        }
    });
});

async function createNamedNoteWithBody(page: Page, title: string): Promise<void> {
    await createNoteAndNavigate(page);
    const input = breadcrumbRenameInput(page);
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill(title);
    await input.press("Enter");
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await editor.click();
    await editor.fill(`${title} body`);
    await page.keyboard.press("Control+s");
    await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });
}
