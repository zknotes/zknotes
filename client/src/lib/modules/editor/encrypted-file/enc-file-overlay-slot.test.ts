// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { OverlaySlot } from "./enc-file-overlay-slot";

let host: HTMLElement;
beforeEach(() => {
    host = document.createElement("span");
});

const el = (id: string) => {
    const d = document.createElement("div");
    d.dataset.id = id;
    return d;
};

describe("OverlaySlot", () => {
    it("render mounts the element into the host", () => {
        const slot = new OverlaySlot(host);
        slot.render(el("a"));
        expect(host.children.length).toBe(1);
        expect((host.firstElementChild as HTMLElement).dataset.id).toBe("a");
    });

    it("render replaces the previous overlay (it keeps at most one)", () => {
        const slot = new OverlaySlot(host);
        slot.render(el("a"));
        slot.render(el("b"));
        expect(host.children.length).toBe(1);
        expect((host.firstElementChild as HTMLElement).dataset.id).toBe("b");
    });

    it("clear removes the overlay from the host", () => {
        const slot = new OverlaySlot(host);
        slot.render(el("a"));
        slot.clear();
        expect(host.children.length).toBe(0);
    });

    it("clear with no overlay mounted is a no-op", () => {
        const slot = new OverlaySlot(host);
        expect(() => slot.clear()).not.toThrow();
        expect(host.children.length).toBe(0);
    });
});
