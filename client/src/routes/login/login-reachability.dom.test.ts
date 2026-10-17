/**
 * With the server away, the sign-in screen showed a bare "Bad Gateway" on submit and lost the
 * "Create one" link for good: the page asked the server once, on load, and never again. It now says
 * the server cannot be reached, keeps asking, and fills itself in when the server is back.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshInstancePublicConfig = vi.fn();
const getRegistrationStatus = vi.fn();
const performLogin = vi.fn();

// The legal footer reads the cached config; it plays no part in reachability.
vi.mock("$lib/core/constants/public-www", () => ({
    refreshInstancePublicConfig,
    loadInstancePublicConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("$lib/core/api/auth", () => ({ getRegistrationStatus }));
vi.mock("$lib/core/services/auth-service", () => ({ performLogin }));
vi.mock("$lib/core/sync/engine", () => ({ pushPendingMutations: vi.fn() }));
vi.mock("$lib/core/stores/auth-store.svelte", () => ({
    authStore: { setAuthenticated: vi.fn(), setUnlocked: vi.fn() },
}));

const { ApiError } = await import("$lib/core/api/client");
const { RETRY_DELAYS_MS } = await import("$lib/core/api/server-reachability.svelte");
const { default: LoginPage } = await import("./+page.svelte");

let target: HTMLElement | undefined;
let instance: Record<string, unknown> | undefined;

beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    refreshInstancePublicConfig.mockReset();
    getRegistrationStatus.mockReset().mockResolvedValue({ open: true });
    performLogin.mockReset();
});

afterEach(() => {
    if (instance) unmount(instance);
    instance = undefined;
    target?.remove();
    target = undefined;
    vi.useRealTimers();
});

async function settle(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
}

async function render(): Promise<HTMLElement> {
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(LoginPage, { target });
    await settle();
    return target;
}

function text(root: HTMLElement): string {
    return root.textContent?.replace(/\s+/g, " ") ?? "";
}

async function submit(root: HTMLElement): Promise<void> {
    const email = root.querySelector<HTMLInputElement>('input[type="email"]');
    const password = root.querySelector<HTMLInputElement>('input[placeholder="Master password"]');
    if (!email || !password) throw new Error("login form not rendered");
    email.value = "someone@example.com";
    email.dispatchEvent(new Event("input", { bubbles: true }));
    password.value = "correct horse";
    password.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();
}

describe("sign-in screen when the server is away", () => {
    it("says so on load, then fills itself in when the server is back", async () => {
        refreshInstancePublicConfig
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValue({});
        const root = await render();

        expect(root.querySelector('[data-testid="login-server-unreachable"]')).not.toBeNull();
        expect(text(root)).toContain("Can't reach the server");
        expect(root.querySelector('[data-testid="login-signup-link"]')).toBeNull();
        expect(getRegistrationStatus).not.toHaveBeenCalled();

        await settle(RETRY_DELAYS_MS[0]);

        expect(root.querySelector('[data-testid="login-server-unreachable"]')).toBeNull();
        expect(root.querySelector('[data-testid="login-server-back"]')).not.toBeNull();
        // The link the failed first load lost comes back without a reload.
        expect(root.querySelector('[data-testid="login-signup-link"]')).not.toBeNull();
    });

    it("a sign-in that cannot reach the server shows the banner, not 'Bad Gateway'", async () => {
        refreshInstancePublicConfig.mockResolvedValue({});
        performLogin.mockRejectedValue(new ApiError("Bad Gateway", 502));
        const root = await render();

        await submit(root);

        expect(text(root)).not.toContain("Bad Gateway");
        expect(root.querySelector('[data-testid="login-server-unreachable"]')).not.toBeNull();
    });

    it("a server that answers with an error still shows its message, and no banner", async () => {
        refreshInstancePublicConfig.mockResolvedValue({});
        performLogin.mockRejectedValue(new ApiError("Invalid email or password", 401));
        const root = await render();

        await submit(root);

        expect(text(root)).toContain("Invalid email or password");
        expect(root.querySelector('[data-testid="login-server-unreachable"]')).toBeNull();
    });

    it("a stalled server: the button says it is waiting on the server, then a warning, then the banner", async () => {
        // A paused or wedged server accepts the connection and never answers. The button used to
        // say "Decrypting vault…" the whole time, as if the device were busy.
        refreshInstancePublicConfig.mockResolvedValue({});
        let fail: (err: unknown) => void = () => {};
        performLogin.mockImplementation(
            (_email: string, _password: string, opts?: { onStage?: (s: string) => void }) => {
                opts?.onStage?.("contacting");
                return new Promise((_resolve, reject) => {
                    fail = reject;
                });
            },
        );
        const root = await render();

        await submit(root);
        expect(text(root)).toContain("Contacting the server…");
        expect(text(root)).not.toContain("Decrypting vault…");
        expect(root.querySelector('[data-testid="login-server-slow"]')).toBeNull();

        await settle(4_000);
        expect(root.querySelector('[data-testid="login-server-slow"]')).not.toBeNull();

        fail(new ApiError("Gateway Timeout", 504));
        await settle();
        expect(root.querySelector('[data-testid="login-server-slow"]')).toBeNull();
        expect(root.querySelector('[data-testid="login-server-unreachable"]')).not.toBeNull();
        expect(text(root)).toContain("Unlock vault");
    });

    it("the device's own hashing gets no slow-server warning", async () => {
        refreshInstancePublicConfig.mockResolvedValue({});
        performLogin.mockImplementation(
            (_email: string, _password: string, opts?: { onStage?: (s: string) => void }) => {
                opts?.onStage?.("deriving");
                return new Promise(() => {});
            },
        );
        const root = await render();

        await submit(root);
        await settle(10_000);

        expect(text(root)).toContain("Decrypting vault…");
        expect(root.querySelector('[data-testid="login-server-slow"]')).toBeNull();
    });
});
