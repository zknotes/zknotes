/**
 * Input's bind:value — proof that value did not stay in the rest spread.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import InputTestHost from "./Input.test-host.svelte";

type HostExports = { setValueFromParent: (next: string) => void };

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

describe("Input", () => {
    it("bind:value writes to the parent and reads back from it", () => {
        target = document.createElement("div");
        document.body.appendChild(target);
        instance = mount(InputTestHost, { target, props: { value: "hello" } });
        flushSync();

        const input = target.querySelector("input");
        if (!input) throw new Error("input not found");
        expect(input.value).toBe("hello");

        input.value = "typed";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        expect(target.querySelector("[data-testid=host]")?.getAttribute("data-value")).toBe(
            "typed",
        );

        instance?.setValueFromParent("from-parent");
        flushSync();
        expect(input.value).toBe("from-parent");
    });
});
