/**
 * The Checkbox contract: Space yes, Enter no, a label click,
 * bind:checked, and one toggle inside a clickable parent.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import CheckboxTestHost from "./Checkbox.test-host.svelte";

type HostExports = { setCheckedFromParent: (value: boolean) => void };

let target: HTMLElement | undefined;
let instance: HostExports | undefined;

afterEach(() => {
    if (instance) {
        unmount(instance);
        instance = undefined;
    }
    target?.remove();
    target = undefined;
});

function render(props: {
    variant?: "plain" | "label" | "nested";
    checked?: boolean;
    disabled?: boolean;
}) {
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(CheckboxTestHost, { target, props });
    flushSync();
    return target;
}

function getControl(root: HTMLElement): HTMLElement {
    const native = root.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (native) return native;
    const custom = root.querySelector<HTMLElement>('[role="checkbox"]');
    if (!custom) throw new Error("checkbox control not found");
    return custom;
}

function isChecked(root: HTMLElement): boolean {
    const el = getControl(root);
    if (el instanceof HTMLInputElement) return el.checked;
    return el.getAttribute("aria-checked") === "true";
}

function parentChecked(root: HTMLElement): boolean {
    return root.querySelector("[data-testid=host]")?.getAttribute("data-checked") === "true";
}

function parentClicks(root: HTMLElement): number {
    return Number(root.querySelector("[data-testid=host]")?.getAttribute("data-parent-clicks"));
}

/**
 * jsdom does not activate a checkbox on Space. In HTML: Space on a checkbox fires a click if the
 * keydown was not preventDefaulted; Enter does not activate a checkbox (only a button).
 */
function pressKey(el: HTMLElement, key: " " | "Enter") {
    el.focus();
    const down = new KeyboardEvent("keydown", {
        key,
        code: key === " " ? "Space" : "Enter",
        bubbles: true,
        cancelable: true,
    });
    const prevented = !el.dispatchEvent(down);
    if (!prevented && key === " ") {
        el.click();
    }
    el.dispatchEvent(
        new KeyboardEvent("keyup", {
            key,
            code: key === " " ? "Space" : "Enter",
            bubbles: true,
            cancelable: true,
        }),
    );
    flushSync();
}

describe("Checkbox", () => {
    it("Space toggles checked", () => {
        const root = render({ checked: false });
        pressKey(getControl(root), " ");
        expect(isChecked(root)).toBe(true);
        expect(parentChecked(root)).toBe(true);
    });

    it("Enter does not toggle checked", () => {
        const root = render({ checked: false });
        pressKey(getControl(root), "Enter");
        expect(isChecked(root)).toBe(false);
        expect(parentChecked(root)).toBe(false);
    });

    it("a click on the <label> text toggles checked", () => {
        const root = render({ variant: "label", checked: false });
        const label = root.querySelector<HTMLLabelElement>("[data-testid=label]");
        if (!label) throw new Error("label not found");
        label.click();
        flushSync();
        expect(isChecked(root)).toBe(true);
        expect(parentChecked(root)).toBe(true);
    });

    it("bind:checked writes to the parent and reads back from it", () => {
        const root = render({ checked: false });
        getControl(root).click();
        flushSync();
        expect(parentChecked(root)).toBe(true);

        instance?.setCheckedFromParent(false);
        flushSync();
        expect(isChecked(root)).toBe(false);
        expect(parentChecked(root)).toBe(false);
    });

    it("a click inside a parent carrying onclick toggles exactly once", () => {
        const root = render({ variant: "nested", checked: false });
        getControl(root).click();
        flushSync();
        expect(parentClicks(root)).toBe(0);
        expect(isChecked(root)).toBe(true);
        expect(parentChecked(root)).toBe(true);
    });
});
