/**
 * Settings → About offers "Verify this build" only when the instance says where to send the user
 * (`verifyUrl` from /instance-config). A self-host without a page of its own must get no link that
 * would point at someone else's; and the commit the user compares has to be shown in full.
 */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/core/constants/public-www", () => ({
    loadInstancePublicConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("$lib/core/stores", () => ({
    pwaStore: { deferredPrompt: null, promptInstall: vi.fn() },
}));

const { loadInstancePublicConfig } = await import("$lib/core/constants/public-www");
const { default: AppInfoSection } = await import("./AppInfoSection.svelte");

let target: HTMLElement | undefined;
let instance: Record<string, unknown> | undefined;

beforeEach(() => {
    vi.mocked(loadInstancePublicConfig).mockReset();
});

afterEach(() => {
    if (instance) unmount(instance);
    instance = undefined;
    target?.remove();
    target = undefined;
});

async function render(): Promise<HTMLElement> {
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(AppInfoSection, { target });
    // loadInstancePublicConfig() resolves after mount.
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    return target;
}

const verifyLink = (root: HTMLElement) =>
    root.querySelector<HTMLAnchorElement>("#about-verify-btn");

describe("About — Verify this build", () => {
    it("links to the instance's verification page when /instance-config names one", async () => {
        vi.mocked(loadInstancePublicConfig).mockResolvedValue({
            sourceUrl: "https://github.com/zknotes/zknotes",
            verifyUrl: "https://zknotes.example/verify",
        });
        const root = await render();

        const link = verifyLink(root);
        expect(link?.textContent).toBe("Verify this build");
        expect(link?.href).toBe("https://zknotes.example/verify");
        expect(link?.rel).toContain("noopener");
        // The link sits next to Source, where the user already looks for the code.
        expect(root.querySelector("#about-source-btn")).not.toBeNull();
    });

    it("shows no link at all when the instance has no verification page (a self-host)", async () => {
        vi.mocked(loadInstancePublicConfig).mockResolvedValue({
            sourceUrl: "https://github.com/zknotes/zknotes",
        });
        const root = await render();

        expect(verifyLink(root)).toBeNull();
        expect(root.textContent).not.toContain("Verify this build");
    });

    it("shows the full commit the user compares with version.json", async () => {
        vi.mocked(loadInstancePublicConfig).mockResolvedValue({});
        const root = await render();

        // vitest.config.ts defines __COMMIT_HASH__ as "test".
        expect(root.querySelector('[data-testid="about-commit"]')?.textContent).toBe("test");
    });
});
