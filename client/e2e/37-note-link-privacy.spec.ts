import { expect, test } from "@playwright/test";
import { createNoteAndNavigate, dismissBreadcrumbAutoRename } from "./helpers/auth";
import { setupAuthenticatedUser } from "./helpers/auth-helper";

/**
 * A note's title is encrypted on the device, so following a link to a note must not put the link
 * text in a URL: a URL reaches the server's access logs, the Referer header of later requests and
 * the browser history.
 */
const LINK_TEXT = "Divorce lawyer notes";

test.describe("Note links", () => {
    setupAuthenticatedUser();

    test("following a note link keeps its text out of every URL and Referer", async ({ page }) => {
        const targetUrl = await createNoteAndNavigate(page);
        const targetId = new URL(targetUrl).pathname.split("/").pop() ?? "";
        await dismissBreadcrumbAutoRename(page);

        await createNoteAndNavigate(page);
        await dismissBreadcrumbAutoRename(page);
        const editor = page.locator('.ProseMirror[contenteditable="true"]');
        await editor.waitFor({ state: "visible" });
        await editor.click();

        // Paste an internal link, as copying one from another note does.
        await page.evaluate(
            ([html]) => {
                const data = new DataTransfer();
                data.setData("text/html", html ?? "");
                data.setData("text/plain", "link");
                document.querySelector('.ProseMirror[contenteditable="true"]')?.dispatchEvent(
                    new ClipboardEvent("paste", {
                        clipboardData: data,
                        bubbles: true,
                        cancelable: true,
                    }),
                );
            },
            [`<p><a href="/note/${targetId}">${LINK_TEXT}</a></p>`],
        );
        const link = editor.locator(`a[href="/note/${targetId}"]`);
        await expect(link).toHaveText(LINK_TEXT, { timeout: 5_000 });

        const sent: string[] = [];
        page.on("request", (req) => {
            sent.push(req.url());
            const referer = req.headers().referer;
            if (referer) sent.push(referer);
        });

        await link.click();
        await page.waitForURL(`**/note/${targetId}`, { timeout: 15_000 });
        expect(new URL(page.url()).search).toBe("");

        // Let the target page load and sync, so its requests are in the list. (There is no
        // network-idle moment to wait for: the app keeps a live connection open.)
        await editor.waitFor({ state: "visible" });
        await page.waitForTimeout(2_000);
        const leaking = sent.filter((u) => {
            const decoded = decodeURIComponent(u.replace(/\+/g, " "));
            return decoded.includes(LINK_TEXT) || /[?&]title=/.test(u);
        });
        expect(leaking).toEqual([]);
    });
});
