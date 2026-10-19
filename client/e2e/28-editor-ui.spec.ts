import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import { uploadToNote } from "./helpers/files";

/**
 * Editor UI wiring — table, outline, markdown, cross-note undo, clear formatting.
 * The heavier multi-tab / mention-rename scenarios stay at unit+dom.
 */
/** Inserts a 2×2 table through the TablePicker (CELL=18, GAP=3 — hover the grid's second cell). */
async function insert2x2Table(
    page: import("@playwright/test").Page,
    editor: import("@playwright/test").Locator,
) {
    await page.getByTitle("Insert Table", { exact: true }).click();
    const grid = page.getByTestId("table-picker-grid").first();
    await expect(grid).toBeVisible({ timeout: 5_000 });
    const box = await grid.boundingBox();
    if (!box) throw new Error("table picker grid missing");
    await page.mouse.move(box.x + 18 + 3 + 9, box.y + 18 + 3 + 9);
    await page.mouse.click(box.x + 18 + 3 + 9, box.y + 18 + 3 + 9);
    await expect(editor.locator("table")).toBeVisible({ timeout: 5_000 });
}

test.describe("Editor UI", () => {
    setupAuthenticatedUser();

    test("insert table via TablePicker", async ({ page }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });

        await page.getByTitle("Insert Table", { exact: true }).click();
        const grid = page.getByTestId("table-picker-grid").first();
        await expect(grid).toBeVisible({ timeout: 5_000 });
        const box = await grid.boundingBox();
        if (!box) throw new Error("table picker grid missing");
        // CELL=18 GAP=3 — hover 2×2 (col 1, row 1 from 0)
        await page.mouse.move(box.x + 18 + 3 + 9, box.y + 18 + 3 + 9);
        await page.mouse.click(box.x + 18 + 3 + 9, box.y + 18 + 3 + 9);

        await expect(editor.locator("table")).toBeVisible({ timeout: 5_000 });
        await expect(editor.locator("td, th")).toHaveCount(4, { timeout: 5_000 });
    });

    /** A toolbar group → a selection → a command over that selection. */
    test("Column menu inserts next to the caret column", async ({ page }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });
        await insert2x2Table(page, editor);

        // Hovering over the table reveals the contextual toolbar.
        await editor.locator("td, th").first().click();
        await editor.locator("td, th").first().hover();
        await page
            .getByTestId("table-toolbar")
            .getByRole("button", { name: /^Column/ })
            .click();

        // The selection is visible before the command fires (ensureCellSelection).
        await expect(editor.locator("td.selectedCell, th.selectedCell").first()).toBeVisible();

        const menu = page.getByRole("menu", { name: "Table options" });
        await expect(menu).toBeVisible({ timeout: 5_000 });
        await menu.getByRole("menuitem", { name: "Insert column right" }).click();

        await expect(editor.locator("tr").first().locator("th, td")).toHaveCount(3, {
            timeout: 5_000,
        });
    });

    /** Split stays unavailable until the cells have been merged. */
    test("split cell is disabled until cells are merged", async ({ page }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });
        await insert2x2Table(page, editor);

        await editor.locator("td, th").first().click();
        await editor.locator("td, th").first().hover();
        await page.getByTestId("table-toolbar").getByRole("button", { name: /^Cell/ }).click();
        const menu = page.getByRole("menu", { name: "Table options" });
        await expect(menu).toBeVisible({ timeout: 5_000 });
        await expect(menu.getByRole("menuitem", { name: "Split cell" })).toBeDisabled();
    });

    /** Escape closes the menu. */
    test("escape closes the table menu", async ({ page }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });
        await insert2x2Table(page, editor);

        await editor.locator("td, th").first().click();
        await editor.locator("td, th").first().hover();
        await page.getByTestId("table-toolbar").getByRole("button", { name: /^Row/ }).click();
        const menu = page.getByRole("menu", { name: "Table options" });
        await expect(menu).toBeVisible({ timeout: 5_000 });
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden({ timeout: 5_000 });
    });

    /** The toolbar route (the only one on touch) highlights the target before the command. */
    test("toolbar Table menu highlights the caret cell", async ({ page }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });
        await insert2x2Table(page, editor);

        await editor.locator("td, th").first().click();
        await page.getByTitle("Table options", { exact: true }).click();
        await expect(page.getByRole("menu", { name: "Table options" })).toBeVisible({
            timeout: 5_000,
        });
        await expect(editor.locator("td.selectedCell, th.selectedCell")).toHaveCount(1);
    });

    test("outline panel shows headings and click scrolls", async ({ page }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        // H1 via "Headings" toolbar dropdown (HeadingPopover.svelte) — the old direct
        // "Heading 1" toolbar button was replaced by this popover; the test drifted.
        // `title` carries the shortcut too ("Headings (Ctrl+Alt+1…4)") — target the stable aria-label.
        await page.getByLabel("Headings", { exact: true }).click();
        await page.getByRole("button", { name: "Heading 1" }).click();
        // Click inside the H1 itself, not in the middle of the ProseMirror. Two reasons:
        // `locator.type()` aims at the middle, and an empty H1 is a narrow strip at the top, so the
        // click lands below it → a new paragraph and the outline stays "(empty)". And a bare
        // `keyboard.type()` with no click starts before the focus has settled, so the first few
        // characters are lost ("Outline Hea" → the h1 is left as "ding One").
        const h1 = editor.locator("h1");
        await expect(h1).toBeVisible();
        await h1.click();
        await expect(editor).toBeFocused();
        await page.keyboard.type("Outline Heading One");
        await page.keyboard.press("Enter");
        await page.keyboard.type("body under h1");
        await expect(editor.locator("h1")).toHaveText("Outline Heading One");

        // Toggle outline if not auto-shown
        const panel = page.getByTestId("outline-panel");
        if (!(await panel.isVisible().catch(() => false))) {
            await page.getByTitle("Toggle outline (headings)", { exact: true }).click();
        }
        await expect(panel).toBeVisible({ timeout: 10_000 });
        await expect(panel.getByText("Outline Heading One")).toBeVisible();
        await panel.getByText("Outline Heading One").click();
        // After click, heading still in editor (scroll target exists)
        await expect(editor.getByText("Outline Heading One")).toBeVisible();
    });

    // The outline is a sticky panel (Word's navigation pane): nothing opens it but the user, and
    // once they do it stays open — across a reload — until they close it. Both halves are
    // load-bearing, hence a test that reloads twice rather than an assertion on the localStorage
    // key: the key is an implementation detail, "still open after F5" is the promise.
    test("outline stays closed until opened, then survives a reload either way", async ({
        page,
    }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await page.keyboard.type("# Sticky outline");

        const panel = page.getByTestId("outline-panel");
        const toggle = page.getByTitle("Toggle outline (headings)", { exact: true });

        // A heading exists, and the panel still does not show itself.
        await expect(editor.locator("h1")).toHaveText("Sticky outline");
        await expect(panel).toBeHidden();

        await toggle.click();
        await expect(panel).toBeVisible({ timeout: 10_000 });

        await page.reload();
        await expect(panel).toBeVisible({ timeout: 10_000 });

        // Closing is remembered just as firmly as opening.
        await toggle.click();
        await expect(panel).toBeHidden();

        await page.reload();
        await expect(editor).toBeVisible({ timeout: 10_000 });
        await expect(panel).toBeHidden();
    });

    test("Insert Markdown converts to rich text", async ({ page }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });

        // Toolbar "Import / Insert" opens popover with Markdown row
        await page.getByTitle("Import / Insert", { exact: true }).click();
        await page.locator("span", { hasText: "Markdown" }).first().click();

        await expect(page.getByRole("heading", { name: "Insert Markdown" })).toBeVisible({
            timeout: 5_000,
        });
        const ta = page.locator("textarea").first();
        await ta.fill("# From MD\n\n**bold bit**");
        await page.getByRole("button", { name: "Insert", exact: true }).click();

        await expect(editor.locator("h1")).toContainText("From MD", { timeout: 5_000 });
        await expect(editor.locator("strong, b")).toContainText("bold bit");
    });

    test("undo history does not leak across notes (loadContent reset)", async ({ page }) => {
        const urlA = await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        const secretA = `NoteA-secret-${Date.now()}`;
        await editor.type(secretA);
        await page.keyboard.press("Control+s");
        await expect(page.locator("text=/^saved/")).toBeVisible({ timeout: 15_000 });

        const urlB = await createNoteAndNavigate(page);
        expect(urlB).not.toBe(urlA);

        // A fresh note B: the history is empty — undo/redo must not bring back A's content
        await expect(editor).not.toContainText(secretA);
        await editor.click();
        await page.keyboard.press("Control+z");
        await page.keyboard.press("Control+y");
        await expect(editor).not.toContainText(secretA);

        await editor.type("NoteB only");
        await expect(editor).toContainText("NoteB only");
        await page.keyboard.press("Control+z");
        // Undoing only the local typing in B — A's secret must still not appear
        await expect(editor).not.toContainText(secretA);
    });

    test("Clear Formatting on multi-line selection keeps block structure", async ({ page }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await editor.type("line one");
        await page.keyboard.press("Enter");
        await editor.type("line two");
        // Select all and bold, then clear formatting
        await page.keyboard.press("Control+a");
        await page
            .getByTitle("Bold", { exact: true })
            .click()
            .catch(async () => {
                await page.keyboard.press("Control+b");
            });
        await page.getByTitle("Clear Formatting", { exact: true }).click();
        // Still two paragraphs of text
        await expect(editor).toContainText("line one");
        await expect(editor).toContainText("line two");
        const boldCount = await editor.locator("strong, b").count();
        expect(boldCount).toBe(0);
    });

    test("drag-selecting text into editor padding keeps the highlight", async ({ page }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });
        await editor.click();
        const token = `tok${Date.now()}`;
        await page.keyboard.insertText(`hello ${token} world`);

        const para = editor.locator("p").filter({ hasText: token });
        await expect(para).toBeVisible();
        const box = await para.boundingBox();
        if (!box) throw new Error("paragraph missing");

        // Start inside the text, drag past the right edge into the padding wrapper
        // (ProseMirror is max-width 47.5em; wrapper is full width). The old onclick
        // handler treated that mouseup-click as empty-space focus and collapsed it.
        await page.mouse.move(box.x + 4, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width + 80, box.y + box.height / 2, { steps: 8 });
        await page.mouse.up();

        const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
        expect(selected.length, `selection collapsed: ${JSON.stringify(selected)}`).toBeGreaterThan(
            0,
        );
        expect(selected).toContain(token);
    });

    test("drag-selecting a heading and the paragraph below keeps the highlight", async ({
        page,
    }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });
        await editor.click();
        await page.keyboard.insertText("Title line");
        await page.getByLabel("Headings").click();
        await page.getByText("Heading 1", { exact: true }).click();
        await expect(editor.locator("h1")).toContainText("Title line");
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        const token = `tok${Date.now()}`;
        await page.keyboard.insertText(`hello ${token} world`);

        const heading = editor.locator("h1").filter({ hasText: "Title line" });
        const para = editor.locator("p").filter({ hasText: token });
        await expect(para).toBeVisible();
        const hBox = await heading.boundingBox();
        const pBox = await para.boundingBox();
        if (!hBox || !pBox) throw new Error("heading/paragraph missing");

        // Drag from heading through the inter-block margin onto the paragraph.
        // click.target is then the ProseMirror root (common ancestor) — the old
        // empty-space handler collapsed that as if it were padding.
        await page.mouse.move(hBox.x + 8, hBox.y + hBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(pBox.x + pBox.width - 4, pBox.y + pBox.height / 2, { steps: 12 });
        await page.mouse.up();

        const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
        expect(selected.length, `selection collapsed: ${JSON.stringify(selected)}`).toBeGreaterThan(
            0,
        );
        expect(selected).toContain("Title");
        expect(selected).toContain("hello");
    });

    test("View source shows the note HTML as text, copies, and select-all stays in the pre", async ({
        page,
    }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });
        await editor.click();
        const marker = `src-e2e-${Date.now()}`;
        await page.keyboard.insertText(
            `<script>alert(1)</script><img onerror="alert(2)"> ${marker}`,
        );

        await page.getByRole("button", { name: "Note actions" }).click();
        await page.locator(".ctx-menu").getByText("View source…").click();

        const pre = page.getByTestId("note-source-pre");
        await expect(pre).toBeVisible({ timeout: 5_000 });
        await expect(pre).toBeFocused();
        await expect(pre).toContainText(marker);
        // TipTap escapes the typed markup into entities — the source has to stay text, not DOM.
        await expect(pre).toContainText("&lt;script&gt;");
        await expect(pre.locator("script")).toHaveCount(0);
        await expect(pre.locator("img")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Copy to clipboard" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
        await expect(page.locator("textarea")).toHaveCount(0);

        await page.keyboard.press("Control+a");
        const { selected, preText } = await page.evaluate(() => {
            const el = document.querySelector("[data-testid='note-source-pre']");
            return {
                selected: window.getSelection()?.toString() ?? "",
                preText: el?.textContent ?? "",
            };
        });
        expect(preText.length).toBeGreaterThan(0);
        expect(selected).toBe(preText);

        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.getByRole("button", { name: "Copy to clipboard" }).click();
        await expect(page.getByRole("button", { name: "Copied" })).toBeVisible({ timeout: 5_000 });
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toContain(marker);
    });

    test("opening another note closes the source dialog", async ({ page }) => {
        const urlA = await createNoteAndNavigate(page);
        await page.getByRole("button", { name: "Note actions" }).click();
        await page.locator(".ctx-menu").getByText("View source…").click();
        await expect(page.getByTestId("note-source-pre")).toBeVisible({ timeout: 5_000 });

        const urlB = await createNoteAndNavigate(page);
        expect(urlB).not.toBe(urlA);
        await expect(page.getByTestId("note-source-pre")).toHaveCount(0);
    });

    test("History header icon hides below md; Show history remains in ⋯; Share stays visible", async ({
        page,
    }) => {
        await createNoteAndNavigate(page);
        await page.setViewportSize({ width: 375, height: 667 });

        await expect(page.getByRole("button", { name: "Toggle version history" })).toBeHidden();
        await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
        await expect(page.getByRole("button", { name: /Star note/ })).toBeVisible();

        await page.getByRole("button", { name: "Note actions" }).click();
        await page.locator(".ctx-menu").getByText("Show history").click();
        await expect(page.getByTestId("history-panel")).toBeVisible({ timeout: 5_000 });
    });

    test("clicking the editor header closes the history panel", async ({ page }) => {
        await createNoteAndNavigate(page);
        await page.getByRole("button", { name: "Toggle version history" }).click();
        await expect(page.getByTestId("history-panel")).toBeVisible({ timeout: 5_000 });

        const header = page.getByTestId("editor-header");
        const box = await header.boundingBox();
        if (!box) throw new Error("editor header missing");
        // The left edge (the breadcrumbs) — not the history drawer on the right. The backdrop has to be above the header.
        await page.mouse.click(box.x + 24, box.y + box.height / 2);
        await expect(page.getByTestId("history-panel")).toBeHidden({ timeout: 5_000 });
    });

    test("folder breadcrumb menu has no note shortcuts or View source", async ({ page }) => {
        const folderName = `Folder${Date.now()}`;

        await page.getByTitle("New folder", { exact: true }).click();
        const renameInput = page.locator(".tree-item-row input[type='text']");
        await renameInput.waitFor({ state: "visible", timeout: 10_000 });
        await renameInput.fill(folderName);
        await renameInput.press("Enter");

        const folderNode = page
            .locator('[data-node-type="folder"]')
            .filter({ hasText: folderName })
            .first();
        await expect(folderNode).toBeVisible({ timeout: 10_000 });
        await folderNode.click({ button: "right" });
        await page.getByText("New note").click();
        await renameInput.waitFor({ state: "visible", timeout: 10_000 });
        await renameInput.press("Enter");

        await page.waitForURL(/\/note\//, { timeout: 10_000 });
        const header = page.locator(".h-12.border-b").first();
        const folderCrumb = header
            .locator(`[title="Click for options"]`, { hasText: folderName })
            .first();
        await folderCrumb.click();

        const menu = page.locator(".ctx-menu");
        await expect(menu).toBeVisible();
        await expect(menu.getByText("View source…")).toHaveCount(0);
        await expect(menu.getByText("Show history")).toHaveCount(0);
        await expect(menu.getByTestId("note-menu-section-label")).toHaveCount(0);
        await expect(menu.getByText("Rename")).toBeVisible();
        await expect(menu.getByText("New note")).toBeVisible();
    });

    test("Attachments appears in ⋯ only when the note has files and opens the note scope", async ({
        page,
    }) => {
        const noteUrl = await createNoteAndNavigate(page);
        const noteId = noteUrl.split("/note/")[1]?.split(/[?#]/)[0];
        expect(noteId).toBeTruthy();

        await page.getByRole("button", { name: "Note actions" }).click();
        await expect(page.locator(".ctx-menu").getByText(/Attachments/)).toHaveCount(0);
        await page.keyboard.press("Escape");

        await uploadToNote(page, "e2e-src-attach.pdf", "application/pdf", Buffer.from("pdf"));
        await expect(page.getByRole("button", { name: /📎\s*1/ })).toBeVisible({
            timeout: 30_000,
        });

        await page.getByRole("button", { name: "Note actions" }).click();
        const item = page.locator(".ctx-menu").getByText("Attachments (1)");
        await expect(item).toBeVisible();
        await item.click();
        await expect(page).toHaveURL(new RegExp(`/files\\?scope=note:${noteId}`));
    });

    test("source dialog Copy and Close stay on-screen for a long note at 375px", async ({
        page,
    }) => {
        await createNoteAndNavigate(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.click();
        await page.keyboard.insertText(`${"long-source-line\n".repeat(80)}end-marker`);

        await page.getByRole("button", { name: "Note actions" }).click();
        await page.locator(".ctx-menu").getByText("View source…").click();
        await expect(page.getByTestId("note-source-pre")).toBeVisible({ timeout: 5_000 });
        await page.setViewportSize({ width: 375, height: 667 });

        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(375);
        }

        const copy = page.getByRole("button", { name: "Copy to clipboard" });
        const close = page.getByRole("button", { name: "Close", exact: true });
        await expect(copy).toBeVisible();
        await expect(close).toBeVisible();
        const copyBox = await copy.boundingBox();
        const closeBox = await close.boundingBox();
        expect(copyBox).not.toBeNull();
        expect(closeBox).not.toBeNull();
        if (copyBox) {
            expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(667);
        }
        if (closeBox) {
            expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(667);
        }
    });
});
