import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { E2E_OTS_CALENDAR_URL } from "../playwright.shared";
import { setupAuthenticatedUser } from "./helpers/auth-helper";
import { closeFilePanel, fileCard, openFileDetailPanel, uploadDocToFiles } from "./helpers/files";

/**
 * Proof of existence, end to end: seal → pending → confirmed → certificate export, against the local
 * fake calendar (e2e/helpers/fake-ots-calendar.ts). The protocol bytes and the merge are covered by
 * the unit tests against real calendar fixtures; this is the wiring.
 */
test.describe("Seal — proof of existence", () => {
    // The fake calendar's confirm switch is shared state.
    test.describe.configure({ mode: "serial" });
    setupAuthenticatedUser();

    test.beforeEach(async ({ page, request }) => {
        await request.post(`${E2E_OTS_CALENDAR_URL}/__pending`);
        // The export streams through the blob fallback, which Playwright can capture as a download.
        await page.addInitScript(() => {
            delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
        });
    });

    test("seal a file, see it confirmed, export a certificate that checks out", async ({
        page,
        request,
    }) => {
        const name = "sealed-e2e.txt";
        const content = Buffer.from(`sealed content ${Date.now()}`);
        await uploadDocToFiles(page, name, "text/plain", content);

        await openFileDetailPanel(page, name);
        const section = page.getByTestId("seal-section");
        await expect(section).toBeVisible();
        await section.getByTestId("seal-open").click();

        // The first seal on an account asks for the permanence acknowledgement before anything is sent.
        const confirm = page.getByTestId("seal-confirm");
        await expect(confirm).toBeDisabled();
        await page.getByTestId("seal-ack").check();
        await confirm.click();

        const badge = section.getByTestId("seal-badge");
        await expect(badge).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
        // AC7: no export while pending.
        await expect(section.getByTestId("seal-export")).toHaveCount(0);

        // The calendar commits; reopening the panel checks pending seals.
        await request.post(`${E2E_OTS_CALENDAR_URL}/__confirm`);
        await closeFilePanel(page);
        // The list marks the sealed file once the panel closes (still pending at this point).
        const marker = fileCard(page, name).getByTestId("file-marker");
        await expect(marker).toHaveAttribute("data-done", "false");
        await openFileDetailPanel(page, name);
        await expect(section.getByTestId("seal-badge")).toHaveAttribute("data-state", "confirmed", {
            timeout: 30_000,
        });
        // No block source in E2E: the confirmation time stands in, and says so.
        await expect(section.getByTestId("seal-existed-before")).toHaveAttribute(
            "data-source",
            "confirmation",
        );

        await section.getByTestId("seal-export").click();
        const downloadPromise = page.waitForEvent("download");
        await page.getByTestId("seal-export-confirm").click();
        const download = await downloadPromise;
        const zip = unzipSync(new Uint8Array(await readFile((await download.path()) as string)));

        expect(Object.keys(zip).sort()).toEqual(
            ["VERIFY.txt", "certificate.pdf", "manifest.json", "manifest.json.ots", name].sort(),
        );
        const manifest = JSON.parse(Buffer.from(zip["manifest.json"] as Uint8Array).toString());
        const fileHash = createHash("sha256")
            .update(zip[name] as Uint8Array)
            .digest("hex");
        expect(Buffer.from(zip[name] as Uint8Array).equals(content)).toBe(true);
        expect(fileHash).toBe(manifest.content_sha256);
        expect(Buffer.from(zip["VERIFY.txt"] as Uint8Array).toString()).toContain(fileHash);
    });
});
