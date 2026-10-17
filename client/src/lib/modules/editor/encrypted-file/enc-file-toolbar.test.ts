// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_EVENTS } from "$lib/core/constants/events";
import { ToolbarController } from "./enc-file-toolbar";

let host: HTMLElement;

beforeEach(() => {
    host = document.createElement("span");
    document.body.appendChild(host);
});
afterEach(() => {
    host.remove();
});

function buttonLabels(): string[] {
    return [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
}

/** Catches the CustomEvent bubbling from the host and returns detail.fileId for the last one emitted. */
function captureBubbled(event: string): () => string | undefined {
    let last: string | undefined;
    document.body.addEventListener(event, (e) => {
        last = (e as CustomEvent<{ fileId: string }>).detail.fileId;
    });
    return () => last;
}

describe("ToolbarController", () => {
    it("an image (not deleted) → Crop + Info + Remove", () => {
        const tb = new ToolbarController(host);
        tb.show("file-1", true, false);
        expect(buttonLabels()).toEqual(["Crop", "Info", "Remove"]);
        expect(tb.visible).toBe(true);
    });

    it("a non-image → no Crop (Info + Remove)", () => {
        new ToolbarController(host).show("file-1", false, false);
        expect(buttonLabels()).toEqual(["Info", "Remove"]);
    });

    it("a deleted file → Remove alone (no Crop/Info)", () => {
        new ToolbarController(host).show("file-1", true, true);
        expect(buttonLabels()).toEqual(["Remove"]);
    });

    it("a click on a button bubbles the right event carrying the fileId", () => {
        const tb = new ToolbarController(host);
        const crop = captureBubbled(APP_EVENTS.encfileCropRequest);
        const info = captureBubbled(APP_EVENTS.encfileInfo);
        const remove = captureBubbled(APP_EVENTS.encfileDelete);
        tb.show("file-42", true, false);

        const [cropBtn, infoBtn, removeBtn] = [...host.querySelectorAll("button")];
        cropBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        infoBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        removeBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(crop()).toBe("file-42");
        expect(info()).toBe("file-42");
        expect(remove()).toBe("file-42");
    });

    it("idempotent: a second show does not create a second toolbar", () => {
        const tb = new ToolbarController(host);
        tb.show("file-1", true, false);
        tb.show("file-1", true, false);
        expect(host.querySelectorAll("span").length).toBe(1);
    });

    it("show adds the selection ring; clear takes it away and removes the toolbar", () => {
        const tb = new ToolbarController(host);
        tb.show("file-1", true, false);
        expect(host.classList.contains("ring-2")).toBe(true);

        tb.clear();
        expect(tb.visible).toBe(false);
        expect(host.querySelector("span")).toBeNull();
        expect(host.classList.contains("ring-2")).toBe(false);
    });

    it("a mousedown on the toolbar preventDefaults (it keeps the focus on the editor)", () => {
        new ToolbarController(host).show("file-1", true, false);
        const toolbar = host.querySelector("span") as HTMLElement;
        const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        toolbar.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
    });
});
