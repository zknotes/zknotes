/**
 * Settings → Delete vault refuses to delete a vault other than the one the caller named, and the
 * refusal has to survive what drops a URL fragment (the sign-in redirect, signing out and back in,
 * a tab switch) and a failed identity lookup. A production incident deleted the wrong vault because
 * the account area and the app keep separate sessions; these tests pin the guard.
 */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/core/api/auth", () => ({ getMe: vi.fn() }));
vi.mock("$lib/core/constants/public-www", () => ({
    loadInstancePublicConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("$lib/core/services/auth-service", () => ({
    performDeleteAccount: vi.fn().mockResolvedValue(undefined),
}));

const { getMe } = await import("$lib/core/api/auth");
const { performDeleteAccount } = await import("$lib/core/services/auth-service");
const { captureExpectedVaultEmailOnArrival, DELETE_VAULT_PATH } = await import(
    "$lib/core/stores/delete-vault-expected"
);
const { default: DeleteAccountSection } = await import("./DeleteAccountSection.svelte");

const STORAGE_KEY = "cn_delete_vault_expected_email";

let target: HTMLElement | undefined;
let instance: Record<string, unknown> | undefined;

beforeEach(() => {
    sessionStorage.clear();
    window.location.hash = "";
    vi.mocked(getMe).mockReset();
    vi.mocked(performDeleteAccount).mockClear();
});

afterEach(() => {
    if (instance) unmount(instance);
    instance = undefined;
    target?.remove();
    target = undefined;
});

async function settle(): Promise<void> {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
}

async function render(): Promise<HTMLElement> {
    if (instance) unmount(instance);
    target?.remove();
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(DeleteAccountSection, { target });
    // getMe() resolves asynchronously after mount.
    await settle();
    return target;
}

const signedInAs = (email: string) =>
    vi.mocked(getMe).mockResolvedValue({ email } as Awaited<ReturnType<typeof getMe>>);

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
    const button = [...root.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(text),
    );
    if (!button) throw new Error(`no button containing "${text}"`);
    return button;
}

const mismatch = (root: HTMLElement) => root.querySelector('[data-testid="delete-vault-mismatch"]');
const unconfirmed = (root: HTMLElement) =>
    root.querySelector('[data-testid="delete-vault-unconfirmed"]');
// Markup wraps the sentences, so the text is compared with its whitespace collapsed.
const textOf = (el: Element | null) => el?.textContent?.replace(/\s+/g, " ") ?? "";

describe("Delete vault — the vault the caller came for", () => {
    it("AC1: a fragment naming another vault blocks the deletion and is remembered for the tab", async () => {
        window.location.hash = "#email=a%40x";
        signedInAs("b@x");
        const root = await render();

        expect(textOf(mismatch(root))).toContain("a@x");
        expect(textOf(mismatch(root))).toContain("b@x");
        expect(buttonByText(root, "Delete vault…").disabled).toBe(true);
        expect(sessionStorage.getItem(STORAGE_KEY)).toBe("a@x");
    });

    it("AC2 (signed-out arrival): the layout captures the fragment before the sign-in redirect, and the section finds it later without any fragment", async () => {
        // What (app)/+layout.svelte does on arrival — the section itself never mounts while the
        // vault is locked, so this is the only place the address can be read in that case.
        captureExpectedVaultEmailOnArrival({ pathname: DELETE_VAULT_PATH, hash: "#email=a%40x" });
        // …sign-in happened, the user navigated to Settings → Delete vault by hand: no fragment.
        signedInAs("b@x");
        const root = await render();
        expect(mismatch(root)).not.toBeNull();
        expect(buttonByText(root, "Delete vault…").disabled).toBe(true);
    });

    it("AC2: without a fragment the remembered address still applies, and a matching vault lifts the block", async () => {
        sessionStorage.setItem(STORAGE_KEY, "a@x");
        signedInAs("b@x");
        let root = await render();
        expect(mismatch(root)).not.toBeNull();
        expect(buttonByText(root, "Delete vault…").disabled).toBe(true);

        // Signed out, signed in to the right vault, came back by hand (no fragment this time).
        signedInAs("A@x");
        root = await render();
        expect(mismatch(root)).toBeNull();
        expect(buttonByText(root, "Delete vault…").disabled).toBe(false);
    });

    it("AC3: when the signed-in vault cannot be confirmed the deletion stays blocked until a retry succeeds", async () => {
        window.location.hash = "#email=a%40x";
        vi.mocked(getMe).mockRejectedValue(new Error("network"));
        const root = await render();

        expect(textOf(unconfirmed(root))).toContain("could not confirm");
        expect(buttonByText(root, "Delete vault…").disabled).toBe(true);

        signedInAs("a@x");
        buttonByText(root, "Retry").click();
        await settle();
        expect(unconfirmed(root)).toBeNull();
        expect(buttonByText(root, "Delete vault…").disabled).toBe(false);
    });

    it("AC4: with nobody naming a vault nothing is blocked, and a completed deletion forgets the address", async () => {
        signedInAs("a@x");
        let root = await render();
        expect(mismatch(root)).toBeNull();
        expect(unconfirmed(root)).toBeNull();
        expect(buttonByText(root, "Delete vault…").disabled).toBe(false);

        // The same, with a matching expectation remembered: the deletion goes through and clears it.
        sessionStorage.setItem(STORAGE_KEY, "a@x");
        root = await render();
        buttonByText(root, "Delete vault…").click();
        await settle();
        const password = root.querySelector<HTMLInputElement>("#delete-password");
        const confirm = root.querySelector<HTMLInputElement>("#delete-confirm");
        if (!password || !confirm) throw new Error("delete form not rendered");
        password.value = "pw";
        password.dispatchEvent(new Event("input", { bubbles: true }));
        confirm.value = "DELETE";
        confirm.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        buttonByText(root, "Permanently delete vault").click();
        await settle();

        expect(performDeleteAccount).toHaveBeenCalledWith("pw");
        expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("changing one's mind clears the remembered address and unblocks the signed-in vault", async () => {
        window.location.hash = "#email=a%40x";
        signedInAs("b@x");
        const root = await render();
        expect(mismatch(root)).not.toBeNull();

        buttonByText(root, "after all").click();
        await settle();
        expect(mismatch(root)).toBeNull();
        expect(buttonByText(root, "Delete vault…").disabled).toBe(false);
        expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
});
