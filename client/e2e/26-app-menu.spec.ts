import { expect, test } from "@playwright/test";
import { createNoteAndNavigate } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

/**
 * The sidebar app menu (gear) and the note "…" menu in the editor header (a shared ItemContextMenu).
 * The header's ⋯ for an open note carries the shortcuts plus "This note"; the sidebar keeps Star.
 */
test.describe("Sidebar app menu", () => {
    setupAuthenticatedUser();

    test("gear opens the menu; second click and Escape close it", async ({ page }) => {
        const trigger = page.getByTitle("Settings and preferences");
        const menu = page.locator(".ctx-menu");

        await trigger.click();
        await expect(menu).toBeVisible();

        // A second click on the gear (a toggle) closes it. While the menu is open, a full-viewport
        // The click-outside overlay (the same pattern as ThemePicker and UiZoomPicker) lies over the
        // trigger, so it is the real hit target for an actual mouse click at those coordinates —
        // force: true simulates that (Playwright otherwise refuses a "covered" click).
        await trigger.click({ force: true });
        await expect(menu).not.toBeVisible();

        await trigger.click();
        await expect(menu).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(menu).not.toBeVisible();

        // Escape returns the focus to the trigger.
        await expect(trigger).toBeFocused();
    });

    test("stepping zoom does not close the menu; clicking Settings does", async ({ page }) => {
        const trigger = page.getByTitle("Settings and preferences");
        const menu = page.locator(".ctx-menu");

        await trigger.click();
        await expect(menu).toBeVisible();

        const increase = menu.getByRole("button", { name: "Increase zoom" });
        const decrease = menu.getByRole("button", { name: "Decrease zoom" });

        // Auto is the lower bound — Decrease starts disabled.
        await expect(decrease).toBeDisabled();

        await increase.click();
        await expect(menu).toBeVisible(); // a stepper click does not close the menu
        await expect(menu.getByText("80%", { exact: true })).toBeVisible();
        await expect(decrease).toBeEnabled();

        await menu.locator(".ctx-item", { hasText: "Settings" }).click();
        await expect(menu).not.toBeVisible();
        await expect(page).toHaveURL(/\/settings/);
    });

    test("zoom stepper reaches the 240% ceiling and disables Increase", async ({ page }) => {
        const trigger = page.getByTitle("Settings and preferences");
        const menu = page.locator(".ctx-menu");

        await trigger.click();
        const increase = menu.getByRole("button", { name: "Increase zoom" });

        // auto → 80 → 100 → 120 → 140 → 160 → 180 → 200 → 220 → 240 (9 steps from Auto).
        for (let i = 0; i < 9; i++) {
            await increase.click();
        }
        await expect(menu.getByText("240%", { exact: true })).toBeVisible();
        await expect(increase).toBeDisabled();
    });

    test("afterNavigate closes the menu when Help and docs is opened", async ({ page }) => {
        const trigger = page.getByTitle("Settings and preferences");
        const menu = page.locator(".ctx-menu");

        await trigger.click();
        await menu.locator(".ctx-item", { hasText: "Help and docs" }).click();
        await page.waitForURL(/\/help/);
        await expect(menu).not.toBeVisible();
    });

    test("Settings remembers the last visited tab, but not Delete Account", async ({ page }) => {
        const trigger = page.getByTitle("Settings and preferences");
        const menu = page.locator(".ctx-menu");

        // Visit Appearance (a legitimate "last tab").
        await page.goto("/settings/appearance");
        // Visit Delete Account — it must not become the remembered tab.
        // The page renders both the mobile and the desktop navigation (CSS-hidden, not removed from
        // the DOM) — scope to the desktop <nav> (the last in DOM order) to avoid strict mode.
        await page
            .getByRole("navigation")
            .last()
            .getByRole("link", { name: "Delete Account" })
            .click();
        await expect(page).toHaveURL(/\/settings\/delete-account/);

        await page.goto("/");
        await trigger.click();
        await menu.locator(".ctx-item", { hasText: "Settings" }).click();
        await expect(page).toHaveURL(/\/settings\/appearance/);
        expect(page.url()).not.toContain("delete-account");
    });
});

test.describe("Note actions menu", () => {
    setupAuthenticatedUser();

    test("header ⋯ lists shortcuts then This note; Star stays out of the header menu", async ({
        page,
    }) => {
        await createNoteAndNavigate(page);

        const trigger = page.getByRole("button", { name: "Note actions" });
        await trigger.click();
        const menu = page.locator(".ctx-menu");
        await expect(menu).toBeVisible();

        await expect(menu.getByText("All Files")).toHaveCount(0);
        await expect(menu.getByText("Help", { exact: false })).toHaveCount(0);
        await expect(menu.getByText("Show history")).toBeVisible();
        await expect(menu.getByTestId("note-menu-section-label")).toBeVisible();
        await expect(menu.getByText("Rename")).toBeVisible();
        await expect(menu.getByText("Duplicate")).toBeVisible();
        await expect(menu.getByText("Star", { exact: true })).toHaveCount(0);
        await expect(menu.getByText("Keep on this device")).toBeVisible();
        await expect(menu.getByText("View source…")).toBeVisible();
        await expect(menu.getByText("Move to trash")).toBeVisible();
        await expect(menu.getByText(/Attachments/)).toHaveCount(0);

        const labels = (await menu.locator(".ctx-item").allTextContents()).map((t) =>
            t.replace(/\s+/g, " ").trim(),
        );
        expect(labels).toEqual([
            "Show history",
            "Rename",
            "Duplicate",
            "Keep on this device",
            "View source…",
            "Move to trash",
        ]);
    });

    test("sidebar item menu still has Star and no header-only shortcuts", async ({ page }) => {
        await createNoteAndNavigate(page);

        await page.locator(".tree-item-row.active").click({ button: "right" });
        const menu = page.locator(".ctx-menu");
        await expect(menu).toBeVisible();
        await expect(menu.getByText("Star", { exact: true })).toBeVisible();
        await expect(menu.getByText("View source…")).toHaveCount(0);
        await expect(menu.getByText("Show history")).toHaveCount(0);
        await expect(menu.getByTestId("note-menu-section-label")).toHaveCount(0);
    });

    test("Star toggles from the sidebar item menu and reflects in the tree", async ({ page }) => {
        await createNoteAndNavigate(page);

        const row = page.locator(".tree-item-row.active");
        await row.click({ button: "right" });
        await page.locator(".ctx-menu .ctx-item", { hasText: "Star" }).click();

        await expect(page.locator(".tree-item-row.active svg.fill-current")).toBeVisible();

        await row.click({ button: "right" });
        await page.locator(".ctx-menu .ctx-item", { hasText: "Unstar" }).click();
        await expect(page.locator(".tree-item-row.active svg.fill-current")).toHaveCount(0);
    });

    test("Duplicate navigates to the copy and opens rename", async ({ page }) => {
        const originalUrl = await createNoteAndNavigate(page);

        const trigger = page.getByRole("button", { name: "Note actions" });
        await trigger.click();
        await page.locator(".ctx-menu .ctx-item", { hasText: "Duplicate" }).click();

        await expect.poll(() => page.url(), { timeout: 10_000 }).not.toBe(originalUrl);
        await expect(page).toHaveURL(/\/note\//);

        const renameInput = page.locator(".tree-item-row input[type='text']");
        await expect(renameInput).toBeVisible({ timeout: 10_000 });
        await expect(renameInput).toHaveValue(/Copy of/);
    });

    test("Move to trash removes the note from the tree and lists it in Trash", async ({ page }) => {
        await createNoteAndNavigate(page);

        const trigger = page.getByRole("button", { name: "Note actions" });
        await trigger.click();
        await page.locator(".ctx-menu .ctx-item.danger", { hasText: "Move to trash" }).click();

        await page.waitForURL("/");

        await page.goto("/trash");
        await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
        await expect(page.getByText(/Trash · 1 item/)).toBeVisible();
    });
});

test.describe("Sidebar app menu — mobile", () => {
    setupAuthenticatedUser();

    test("menu stays within the viewport on a narrow screen", async ({ page }) => {
        // The sidebar is open by default (on mobile too, as a fixed overlay) — there is no need
        // for the hamburger by clicking; only for the resize listener to update isMobile.
        await page.setViewportSize({ width: 375, height: 640 });

        const trigger = page.getByTitle("Settings and preferences");
        await trigger.waitFor({ state: "visible", timeout: 10_000 });
        await trigger.click();
        const menu = page.locator(".ctx-menu");
        await expect(menu).toBeVisible();

        const box = await menu.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.y + box.height).toBeLessThanOrEqual(640);
        }
    });
});
