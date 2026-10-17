// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ResizeController } from "./enc-file-resize";

function setup(editable = true) {
    const img = document.createElement("img");
    const onCommit = vi.fn();
    const rc = new ResizeController({ img, editable, onCommit });
    document.body.appendChild(rc.handle);
    return { img, onCommit, rc };
}

/** Simulates a drag: a mousedown on the handle, then a mousemove + mouseup on the document (as in a real drag). */
function drag(rc: ResizeController, fromX: number, toX: number) {
    rc.handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: fromX }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: toX }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: toX }));
}

describe("ResizeController", () => {
    it("the handle carries the encfile-resize-handle class", () => {
        const { rc } = setup();
        expect(rc.handle.className).toBe("encfile-resize-handle");
    });

    it("read-only mode hides the handle and setVisible is a no-op", () => {
        const { rc } = setup(false);
        expect(rc.handle.style.display).toBe("none");
        rc.setVisible(true);
        expect(rc.handle.style.display).toBe("none");
    });

    it("editable: setVisible switches display", () => {
        const { rc } = setup(true);
        rc.setVisible(false);
        expect(rc.handle.style.display).toBe("none");
        rc.setVisible(true);
        expect(rc.handle.style.display).toBe("");
    });

    it("a drag to the right: a live preview on the img + onCommit with the final width (fallback 400)", () => {
        const { img, onCommit, rc } = setup();
        // offsetWidth is 0 in happy-dom → the 400 fallback; +50 = 450.
        drag(rc, 100, 150);
        expect(img.style.width).toBe("450px");
        expect(onCommit).toHaveBeenCalledWith(450);
    });

    it("a hard drag to the left: the width is clamped to a minimum of 50", () => {
        const { img, onCommit, rc } = setup();
        drag(rc, 100, -400); // 400 + (-500) = -100 → clamp 50
        expect(img.style.width).toBe("50px");
        expect(onCommit).toHaveBeenCalledWith(50);
    });

    it("mousedown preventDefaults and stops propagation (it does not steal the PM selection)", () => {
        const { rc } = setup();
        const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 0 });
        rc.handle.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        document.dispatchEvent(new MouseEvent("mouseup", { clientX: 0 })); // tidy the listeners away
    });

    it("the document listeners are removed after a mouseup (a further move does not change the width)", () => {
        const { img, rc } = setup();
        drag(rc, 100, 150);
        img.style.width = "999px";
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 9999 }));
        expect(img.style.width).toBe("999px"); // there is no active onMove any more
    });
});
