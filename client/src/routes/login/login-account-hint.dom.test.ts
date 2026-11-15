/**
 * An instance with an account layer has two sign-ins that look the same and take different
 * passwords. The vault's sign-in screen says which one it is and links to the other; a self-host,
 * which has no account origin, must not show the line at all.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshInstancePublicConfig = vi.fn();

vi.mock("$lib/core/constants/public-www", () => ({
    refreshInstancePublicConfig,
    loadInstancePublicConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("$lib/core/api/auth", () => ({
    getRegistrationStatus: vi.fn().mockResolvedValue({ open: false }),
}));
vi.mock("$lib/core/services/auth-service", () => ({ performLogin: vi.fn() }));
vi.mock("$lib/core/sync/engine", () => ({ pushPendingMutations: vi.fn() }));
vi.mock("$lib/core/stores/auth-store.svelte", () => ({
    authStore: { setAuthenticated: vi.fn(), setUnlocked: vi.fn() },
}));

const { default: LoginPage } = await import("./+page.svelte");

let target: HTMLElement | undefined;
let instance: Record<string, unknown> | undefined;

beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    refreshInstancePublicConfig.mockReset();
});

afterEach(() => {
    if (instance) unmount(instance);
    instance = undefined;
    target?.remove();
    target = undefined;
    vi.useRealTimers();
});

async function render(): Promise<HTMLElement> {
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(LoginPage, { target });
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    return target;
}

describe("sign-in screen and the account origin", () => {
    it("names the vault password and links to the account when the instance has one", async () => {
        refreshInstancePublicConfig.mockResolvedValue({
            account: { manageUrl: "https://account.example.test" },
        });
        const root = await render();

        const hint = root.querySelector('[data-testid="login-account-hint"]');
        expect(hint?.textContent).toContain("vault password");
        expect(hint?.textContent).toContain("its own password");
        expect(root.querySelector('[data-testid="login-account-link"]')?.getAttribute("href")).toBe(
            "https://account.example.test",
        );
    });

    it("shows nothing on a self-host, which has no account origin", async () => {
        refreshInstancePublicConfig.mockResolvedValue({});
        const root = await render();

        expect(root.querySelector('[data-testid="login-account-hint"]')).toBeNull();
        expect(root.querySelector('[data-testid="login-account-link"]')).toBeNull();
    });
});
