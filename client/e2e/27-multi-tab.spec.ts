import { expect, type Page, test } from "@playwright/test";
import {
    createNoteAndNavigate,
    registerUser,
    uniqueEmail,
    waitForVaultUnlocked,
} from "./helpers/auth";
import {
    captureEmbedFileId,
    fileCard,
    moveToTrashFromFilePanel,
    openFileDetailPanel,
    uploadToNote,
} from "./helpers/files";

const PASSWORD = "correct-horse-battery-staple";

const editorLocator = (page: Page) => page.locator('.ProseMirror[contenteditable="true"]');

/**
 * Multiple tabs in the SAME BrowserContext (sharing IndexedDB and the SharedWorker) — exactly the
 * model where a version check does not catch a clobber, because both tabs see the same local version.
 *
 * A heavier spec (two pages plus a save race and a BroadcastChannel) → it goes into E2E_HEAVY_SPECS.
 */
test.describe("Multi-tab (same browser context)", () => {
    test("same note open in two tabs: later save keeps both versions via conflict copy", async ({
        page,
        context,
    }) => {
        await registerUser(page, uniqueEmail(), PASSWORD);
        await waitForVaultUnlocked(page);

        const noteUrl = await createNoteAndNavigate(page);
        const noteId = new URL(noteUrl).pathname.split("/note/")[1] as string;
        const editorA = editorLocator(page);

        await editorA.click();
        await editorA.type("BASE CONTENT");
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        // Tab B: the same context → the same IDB + SharedWorker, a separate TipTap state.
        const pageB = await context.newPage();
        await pageB.goto(`/note/${noteId}`);
        await waitForVaultUnlocked(pageB);
        const editorB = editorLocator(pageB);
        await expect(editorB).toContainText("BASE CONTENT", { timeout: 15_000 });

        // Tab A saves its own version (IDB + push).
        await editorA.click();
        await editorA.fill("");
        await editorA.type("FROM TAB A");
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        // Tab B still holds the old editor (it is not dirty until someone types; the broadcast does not
        // invalidate the note query). Edit and save — basedOnContent=BASE while IDB already holds FROM
        // TAB A → our changes go into
        // a conflict copy; the original stays Tab A's (as the "Server Version" in the inbox).
        await editorB.click();
        await editorB.fill("");
        await editorB.type("FROM TAB B");
        await pageB.keyboard.press("Control+s");

        // A toast + the Conflict Inbox; the editor is force-reloaded from IDB (Tab A).
        await expect(pageB.getByText(/updated elsewhere|conflict copy/i).first()).toBeVisible({
            timeout: 10_000,
        });
        await expect(editorB).toContainText("FROM TAB A", { timeout: 15_000 });

        const badge = pageB.locator('button[title="View unresolved conflicts"]');
        await expect(badge).toBeVisible({ timeout: 10_000 });

        await badge.click({ force: true });
        const dialog = pageB.getByRole("dialog");
        await expect(dialog).toBeVisible();
        // The Server panel = the original (Tab A); Offline = ours (Tab B)
        await expect(dialog).toContainText("FROM TAB A");
        await expect(dialog).toContainText("FROM TAB B");

        // Keep Server keeps Tab A and removes the offline copy — the editor stays on Tab A.
        await pageB.getByRole("button", { name: "Keep Server Version" }).click();
        await expect(dialog).toBeHidden({ timeout: 10_000 });
        await expect(editorB).toContainText("FROM TAB A", { timeout: 10_000 });
        await expect(editorB).not.toContainText("FROM TAB B");

        await pageB.close();
    });

    test("logout in one tab locks vault in another open tab", async ({ page, context }) => {
        await registerUser(page, uniqueEmail(), PASSWORD);
        await waitForVaultUnlocked(page);

        const pageB = await context.newPage();
        await pageB.goto("/");
        await waitForVaultUnlocked(pageB);

        // A logout in tab A → a BroadcastChannel message plus a session-generation invalidation.
        await page.getByTitle("Lock vault & logout").click();
        await page.waitForURL(/\/login/, { timeout: 30_000 });

        // Tab B has to end up at the login page (a remote teardown plus location.assign).
        await pageB.waitForURL(/\/login/, { timeout: 30_000 });

        // Reloading tab B must not "resurrect" the vault without a password.
        await pageB.reload();
        await expect(pageB).toHaveURL(/\/login/);
        // There is no app shell (the lock button) without a login.
        await expect(pageB.getByTitle("Lock vault & logout")).toHaveCount(0, { timeout: 5_000 });
        await expect(pageB.getByRole("button", { name: /Unlock vault/i })).toBeVisible();

        await pageB.close();
    });

    // A second user signing in in tab B must not let tab A create
    // (and pushes) a new item under B's cookie — neither readable by B (the SharedWorker branch would
    // decrypt someone else's content) nor as a permanently unreadable "Encrypted…" row (the Dedicated
    // branch).
    // The same context → a shared cookie/localStorage/SharedWorker with a per-tab sessionStorage —
    // the closest realistic simulation of two tabs open in the same browser.
    test("second user login in another tab blocks stale tab from leaking a new item", async ({
        page,
        context,
    }) => {
        await registerUser(page, uniqueEmail(), PASSWORD);
        await waitForVaultUnlocked(page);

        const pageB = await context.newPage();

        // The race: tab A tries to create a new item EXACTLY while tab B is signing in as a DIFFERENT
        // user. Without the primary mechanism (rotate+broadcast+redirect) or the belt (the
        // isVaultSessionCurrent check in createItem), this click could create a row under B's cookie
        // before tab A got to hear about the change.
        await Promise.all([
            registerUser(pageB, uniqueEmail(), PASSWORD),
            page
                .getByTitle("New note")
                .click()
                .catch(() => {}),
        ]);
        await waitForVaultUnlocked(pageB);

        // The primary mechanism: the old tab (A) is notified (the user-changed broadcast) and
        // redirected to /login.
        await page.waitForURL(/\/login/, { timeout: 30_000 });

        // B is a freshly registered user — their tree has to stay empty. Any row here is the
        // failure: A's content leaking to B (SharedWorker), or a permanently unreadable row
        // (Dedicated).
        await pageB.goto("/");
        await expect(pageB.getByRole("treeitem")).toHaveCount(0, { timeout: 10_000 });

        await pageB.close();
    });

    // A file trashed in tab B strips its embed out of the note's stored content. Tab A, mid-edit on
    // that same note, used to see IDB ≠ its baseline ≠ its editor HTML on the next save and park the
    // user's typing in a conflict copy ("updated elsewhere") — for an operation that was not an edit
    // of the note at all. The cross-tab baseline reconcile (remoteFileRefsChanged) keeps it a plain save.
    test("trashing a file in another tab while editing the note does not create a conflict copy", async ({
        page,
        context,
    }) => {
        test.slow();
        await registerUser(page, uniqueEmail(), PASSWORD);
        await waitForVaultUnlocked(page);

        const noteUrl = await createNoteAndNavigate(page);
        const editorA = editorLocator(page);
        await editorA.click();
        await editorA.type("BEFORE FILE");
        const fileName = "e2e-multitab-trash.pdf";
        await uploadToNote(page, fileName, "application/pdf", Buffer.from("fake pdf content"));
        await captureEmbedFileId(page);
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

        // Tab A is dirty again BEFORE tab B touches the file.
        await editorA.click();
        await page.keyboard.press("Control+End");
        await editorA.type(" AND MORE TEXT");

        // Tab B: trash the file from /files.
        const pageB = await context.newPage();
        await pageB.goto("/files");
        await waitForVaultUnlocked(pageB);
        await openFileDetailPanel(pageB, fileName);
        await moveToTrashFromFilePanel(pageB);
        await expect(fileCard(pageB, fileName)).toBeHidden({ timeout: 30_000 });

        // Tab A: the embed leaves the live doc, and the save stays a plain save.
        await expect(page.locator(".encfile-node", { hasText: fileName })).toBeHidden({
            timeout: 15_000,
        });
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(/updated elsewhere|conflict copy/i)).toHaveCount(0);
        await expect(page.locator('button[title="View unresolved conflicts"]')).toHaveCount(0);

        // The typing survived — in the original note, not in a copy.
        await page.reload();
        await waitForVaultUnlocked(page);
        await page.goto(noteUrl);
        // Two paragraphs (the embed sat between them), so check them one by one.
        await expect(editorLocator(page)).toContainText("BEFORE FILE", { timeout: 20_000 });
        await expect(editorLocator(page)).toContainText("AND MORE TEXT", { timeout: 20_000 });
        await expect(page.locator(".encfile-node", { hasText: fileName })).toHaveCount(0);
        await expect(page.locator('button[title="View unresolved conflicts"]')).toHaveCount(0);

        await pageB.close();
    });
});
