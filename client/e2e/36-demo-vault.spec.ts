import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { waitForVaultUnlocked } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

/**
 * The demo vault (`bun scripts/make-demo-vault.ts`) is generated outside the app, so its note HTML
 * is hand-written against the editor's own serialisation. When that drifts — a block node wrapped in
 * a paragraph, an `alt` the NodeView syncs back, a math span missing its delimiters — the editor
 * silently rewrites the note the moment it opens, and every demo note lands dirty. That is invisible
 * to the generator's own tests, which is why the check lives here.
 */
test.describe("Demo vault", () => {
    setupAuthenticatedUser();

    test("imports through the restore wizard and opens without rewriting itself", async ({
        page,
    }) => {
        // Through the CLI, so the generator's real entry point is what gets exercised. A fresh seed
        // per run: an item id is a global primary key, so two vaults cannot share one.
        const root = fileURLToPath(new URL("../..", import.meta.url));
        const zip = join(mkdtempSync(join(tmpdir(), "zknotes-demo-")), "demo-vault.zip");
        execFileSync("bun", ["scripts/make-demo-vault.ts", zip, "--seed", `e2e-${Date.now()}`], {
            cwd: root,
            stdio: "pipe",
        });

        await page.goto("/settings");
        await page.getByRole("link", { name: "Backup" }).click();
        await expect(page.locator("h1", { hasText: "Backup" })).toBeVisible();
        await page.locator('input[type="file"][accept*="cnbackup"]').setInputFiles(zip);
        await page.getByText("Overwrite all", { exact: false }).click();
        await page.getByRole("button", { name: "Start restore" }).click();
        await page.getByRole("button", { name: "Confirm restore" }).click();
        await expect(page.getByTestId("restore-complete")).toBeVisible({ timeout: 60_000 });

        const searchInput = page.getByPlaceholder("Search notes, folders…");
        const openNote = async (query: string, title: string) => {
            await page.goto("/");
            // After a full load the palette's Ctrl+K listener exists only once the vault shell has
            // mounted again: a key pressed before that is lost, and the palette stays shut.
            await waitForVaultUnlocked(page);
            await page.keyboard.press("Control+k");
            await expect(searchInput).toBeVisible({ timeout: 15_000 });
            await searchInput.fill(query);
            // Click the note's own title once the search has highlighted it. Until the debounced
            // search lands, the palette still lists the recent items, unhighlighted, and one of
            // them can be the note's attachment, whose path spells the note's title: a click there
            // opens nothing. Enter is no better then: with no hits yet, it creates a note.
            const hit = page
                .locator("dialog")
                .getByText(title, { exact: true })
                .filter({ has: page.locator("mark") });
            await expect(hit).toBeVisible();
            await hit.click();
            await page.waitForURL(/\/note\//, { timeout: 20_000 });
            await expect(page.locator(".ProseMirror")).not.toBeEmpty({ timeout: 20_000 });
        };

        // "local only" is version=1 plus dirty — exactly the state an unwanted rewrite produces.
        const localOnly = page.getByText("local only", { exact: false });
        for (const { query, title } of [
            { query: "start here", title: "Start here — demo vault tour" },
            { query: "stats cheat", title: "Statistics cheat sheet" },
            { query: "thermo", title: "Thermostability of β-glucosidase — assay log" },
        ]) {
            await openNote(query, title);
            await page.waitForTimeout(3_000);
            await expect(localOnly, `${query} was rewritten on open`).toBeHidden();
        }

        // The attachment really decrypted and rendered, rather than falling back to a chip.
        await expect(page.locator(".ProseMirror img[src^='blob:']").first()).toBeVisible({
            timeout: 20_000,
        });
    });
});
