/**
 * The PasswordStrength contract: the advice is always there, the meter and its verdict appear only
 * once something is typed, and the verdict sits in a live region that exists from the start.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import PasswordStrength from "./PasswordStrength.svelte";

let target: HTMLElement | undefined;
let instance: Record<string, unknown> | undefined;

afterEach(() => {
    if (instance) {
        unmount(instance);
        instance = undefined;
    }
    target?.remove();
    target = undefined;
});

function render(password: string): HTMLElement {
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(PasswordStrength, { target, props: { password, id: "advice" } });
    flushSync();
    return target;
}

function verdict(root: HTMLElement): HTMLElement {
    const el = root.querySelector<HTMLElement>("[aria-live]");
    if (!el) throw new Error("live region not found");
    return el;
}

describe("PasswordStrength", () => {
    it("shows the advice but no meter and no verdict for an empty password", () => {
        const root = render("");
        expect(root.querySelector("#advice")?.textContent).toContain("Four random words");
        expect(root.querySelector("[aria-hidden=true]")).toBeNull();
        expect(verdict(root).textContent?.trim()).toBe("");
    });

    it("names a weak password and says why", () => {
        const root = render("Password1!");
        const live = verdict(root);
        expect(live.dataset.strength).toBe("weak");
        expect(live.textContent).toContain("Weak");
        expect(live.textContent).toContain("Well-known passwords");
    });

    it("calls a passphrase strong without advice", () => {
        const live = verdict(render("lamp river cactus tuesday"));
        expect(live.dataset.strength).toBe("strong");
        expect(live.textContent?.trim()).toBe("Strong");
    });
});
