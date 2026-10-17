import {
    type APIRequestContext,
    type BrowserContext,
    expect,
    type Page,
    type PlaywrightWorkerArgs,
    test,
} from "@playwright/test";
import {
    createNoteAndNavigate,
    registerUser,
    uniqueEmail,
    waitForVaultUnlocked,
} from "./helpers/auth";

const PASSWORD = "correct-horse-battery-staple";
const API_URL = "http://localhost:3001";

const editorLocator = (page: Page) => page.locator('.ProseMirror[contenteditable="true"]');

async function seedDivergentConflict(
    page: Page,
    context: BrowserContext,
    playwright: PlaywrightWorkerArgs["playwright"],
    opts: { typeBeforeReconnect?: string } = {},
): Promise<{ noteId: string; api: APIRequestContext }> {
    await registerUser(page, uniqueEmail(), PASSWORD);
    await waitForVaultUnlocked(page);

    const session = (await context.cookies()).find((c) => c.name === "session_token");
    const api = await playwright.request.newContext({
        baseURL: API_URL,
        extraHTTPHeaders: { Cookie: `session_token=${session?.value}`, Connection: "close" },
    });

    const noteUrl = await createNoteAndNavigate(page);
    const noteId = new URL(noteUrl).pathname.split("/note/")[1] as string;
    const editor = editorLocator(page);

    await editor.click();
    await editor.type("SERVER VERSION");
    await page.keyboard.press("Control+s");
    await expect(page.locator("text=/^saved/i")).toBeVisible({ timeout: 15_000 });

    await expect(async () => {
        const body = (await (await api.get("/items?since=0&limit=1000")).json()) as {
            items: { id: string; version: number }[];
        };
        expect(body.items.some((i) => i.id === noteId)).toBe(true);
    }).toPass({ timeout: 15_000 });

    await context.setOffline(true);
    await editor.click();
    await editor.fill("");
    await editor.type("OFFLINE VERSION");
    await page.keyboard.press("Control+s");
    await expect(page.locator("text=/pending/i").first()).toBeVisible({ timeout: 10_000 });

    const current = (await (await api.get("/items?since=0&limit=1000")).json()) as {
        items: { id: string; version: number }[];
    };
    const serverVersion = current.items.find((i) => i.id === noteId)?.version;
    await api.put(`/items/${noteId}`, { data: { version: serverVersion } });

    // Typed after the offline save and never saved: it is only in the open editor when the push
    // comes back 409 (the autosave idle is 10 s, the reconnect is immediate).
    if (opts.typeBeforeReconnect) {
        await editor.press("End");
        await editor.pressSequentially(opts.typeBeforeReconnect);
    }

    await context.setOffline(false);
    await expect(page.locator("text=/pending/i").first()).toBeHidden({ timeout: 15_000 });

    return { noteId, api };
}

/**
 * Smoke — the Conflict Inbox badge + the diff + one resolve path (Keep Server).
 * The dedup and the other resolve paths live in conflict.integration.test.ts + engine.integration.test.ts.
 */
test.describe("Conflict Inbox — smoke", () => {
    test("divergent conflict shows inbox diff and resolves via Keep Server", async ({
        page,
        context,
        playwright,
    }) => {
        const { noteId, api } = await seedDivergentConflict(page, context, playwright);

        const badge = page.locator('button[title="View unresolved conflicts"]');
        await expect(badge).toBeVisible();
        await expect(badge).toContainText("1 conflict");
        await badge.click({ force: true });

        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Conflict Inbox");
        await expect(dialog).toContainText("SERVER VERSION");
        await expect(dialog).toContainText("OFFLINE VERSION");

        await page.getByRole("button", { name: "Keep Server Version" }).click();
        await expect(dialog).toBeHidden();
        await expect(badge).toBeHidden();

        await page.goto(`/note/${noteId}`);
        await page.reload();
        await waitForVaultUnlocked(page);
        await expect(editorLocator(page)).toContainText("SERVER VERSION", { timeout: 15_000 });

        await api.dispose();
    });
});

/**
 * The push 409 reaches the open editor. Before, the editor kept the offline text and made
 * no sound; its next save then made a second copy. Now it shows the other device's version at once, a
 * toast names the copy, and the one copy holds everything typed, the unsaved tail included.
 */
test.describe("Conflict — push 409 with the note open", () => {
    test("the editor shows the server version, and one copy holds all of the offline text", async ({
        page,
        context,
        playwright,
    }) => {
        const { api } = await seedDivergentConflict(page, context, playwright, {
            typeBeforeReconnect: " AND MORE",
        });

        const editor = editorLocator(page);
        await expect(editor).toContainText("SERVER VERSION", { timeout: 15_000 });
        await expect(editor).not.toContainText("OFFLINE VERSION");
        // Before the fix the editor got here too, but only after its autosave (10 s) had made a SECOND
        // copy from the unsaved tail — the badge then reads "2 conflicts to resolve".
        const badge = page.locator('button[title="View unresolved conflicts"]');
        await expect(badge).toContainText("1 conflict to resolve");
        await expect(page.getByText(/changed on another device/i)).toBeVisible();

        await badge.click({ force: true });
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText("OFFLINE VERSION");
        await expect(dialog).toContainText("AND MORE");

        await api.dispose();
    });
});
