import { expect, test } from "@playwright/test";
import {
    createNoteAndNavigate,
    loginUser,
    registerUser,
    uniqueEmail,
    waitForVaultUnlocked,
} from "./helpers/auth";

const PASSWORD = "correct-horse-battery-staple";
const API_URL = "http://localhost:3001";

/**
 * Two real browser contexts on the SAME account (sharing the vault key derived from one password).
 * Device A edits a note and pushes; Device B, with the same note open, pulls the change when its tab
 * becomes visible again, WITHOUT a reload → the editor updates live and an "Updated from another
 * device" flash banner appears.
 *
 * This covers the whole live cross-device pipeline: the scheduler's visibility sync → a pull → the
 * note query invalidation → the editor's loadContent(highlightChanges) → the sync flash. A tab switch,
 * not window focus: focus starts no cycle within 30 s of the last one, and B pulled only
 * seconds ago, when it opened the note.
 */
test("live cross-device edit updates the open editor and shows the sync flash banner", async ({
    browser,
    playwright,
}) => {
    const email = uniqueEmail();

    // ── Device A: register, create a note, write content, sync ──
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await registerUser(pageA, email, PASSWORD);
    await waitForVaultUnlocked(pageA);

    const noteUrl = await createNoteAndNavigate(pageA);
    const noteId = new URL(noteUrl).pathname.split("/note/")[1] as string;
    const editorA = pageA.locator('.ProseMirror[contenteditable="true"]');
    await editorA.click();
    await editorA.type("ORIGINAL CONTENT");
    await pageA.keyboard.press("Control+s");
    await expect(pageA.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

    // An API context (through A's session) — for reliably waiting until the pushes settle on the server.
    const session = (await ctxA.cookies()).find((c) => c.name === "session_token");
    const api = await playwright.request.newContext({
        baseURL: API_URL,
        // `Connection: close` is MANDATORY: the API runtime is Bun, which (unlike Node) does not close
        // idle keep-alive connections. Without this a Node-side request socket lingers even after
        // `api.dispose()`, keeps the Playwright worker alive, so Playwright waits 300 s at teardown.
        extraHTTPHeaders: { Cookie: `session_token=${session?.value}`, Connection: "close" },
    });

    let baseVersion = 0;
    await expect(async () => {
        const body = (await (await api.get("/items?since=0&limit=1000")).json()) as {
            items: { id: string; version: number }[];
        };
        const it = body.items.find((i) => i.id === noteId);
        expect(it).toBeTruthy();
        baseVersion = it?.version ?? 0;
    }).toPass({ timeout: 15_000 });

    // ── Device B: the same account, open the same note, see the original content ──
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await loginUser(pageB, email, PASSWORD);
    await waitForVaultUnlocked(pageB);
    await pageB.goto(`/note/${noteId}`);
    const editorB = pageB.locator('.ProseMirror[contenteditable="true"]');
    await expect(editorB).toContainText("ORIGINAL CONTENT", { timeout: 15_000 });

    // ── Device A: edit and push ──
    await editorA.click();
    await editorA.fill("");
    await editorA.type("UPDATED FROM DEVICE A");
    await pageA.keyboard.press("Control+s");
    await expect(pageA.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

    // Wait for the second version to reach the server BEFORE triggering B's sync (no race).
    await expect(async () => {
        const body = (await (await api.get("/items?since=0&limit=1000")).json()) as {
            items: { id: string; version: number }[];
        };
        const it = body.items.find((i) => i.id === noteId);
        expect(it?.version ?? 0).toBeGreaterThan(baseVersion);
    }).toPass({ timeout: 15_000 });

    // ── Device B: back to the tab → scheduler syncNow → pull → live update + flash ──
    await pageB.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

    // The flash banner appears (it is transient, lasting ~2.6s).
    await expect(pageB.getByText("Updated from another device")).toBeVisible({ timeout: 10_000 });
    // The editor updated live, with no reload.
    await expect(editorB).toContainText("UPDATED FROM DEVICE A", { timeout: 10_000 });

    await api.dispose();
    await ctxA.close();
    await ctxB.close();
});
