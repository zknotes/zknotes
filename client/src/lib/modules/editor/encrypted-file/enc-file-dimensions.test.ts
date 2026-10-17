// @vitest-environment happy-dom
//
// An `encFile` node carries intrinsic dimensions (`data-w`/`data-h`) so the
// NodeView reserves exactly the right space BEFORE the image is decrypted. Without them the `<img>` is
// 0 px tall until the bytes arrive, and everything below jumps (CLS).
//
// These tests hold the attribute contract (a parse/render round trip plus tolerance of old content).
// The NodeView's behaviour — the reservation and the self-heal — is covered by E2E, because it needs a
// real layout engine.
import { describe, expect, it } from "vitest";
import { EncFile } from "./enc-file-node";

type AttrSpec = {
    default: unknown;
    parseHTML?: (el: HTMLElement) => unknown;
    renderHTML?: (attrs: Record<string, unknown>) => Record<string, string>;
};

function attrs(): Record<string, AttrSpec> {
    // addAttributes is a Node.create config function — we call it directly, with no TipTap editor.
    return (EncFile.config.addAttributes as () => Record<string, AttrSpec>).call(EncFile);
}

function el(html: string): HTMLElement {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild as HTMLElement;
}

describe("encFile intrinsic dimensions", () => {
    it("parses data-w / data-h out of the HTML as numbers", () => {
        const a = attrs();
        const img = el('<img data-file-id="f1" data-w="1600" data-h="900">');
        expect(a.w?.parseHTML?.(img)).toBe(1600);
        expect(a.h?.parseHTML?.(img)).toBe(900);
    });

    it("renders them back into data-w / data-h (the round trip survives export, share and history)", () => {
        const a = attrs();
        expect(a.w?.renderHTML?.({ w: 1600 })).toEqual({ "data-w": "1600" });
        expect(a.h?.renderHTML?.({ h: 900 })).toEqual({ "data-h": "900" });
    });

    it("old content with no attributes yields null, not NaN (it has to keep working as before)", () => {
        const a = attrs();
        const img = el('<img data-file-id="f1">');
        expect(a.w?.parseHTML?.(img)).toBeNull();
        expect(a.h?.parseHTML?.(img)).toBeNull();
        expect(a.w?.default).toBeNull();
        expect(a.h?.default).toBeNull();
    });

    it("discards nonsensical values (0, negative, text) rather than letting them through", () => {
        const a = attrs();
        for (const bad of ['data-w="0"', 'data-w="-5"', 'data-w="abc"', 'data-w=""']) {
            expect(a.w?.parseHTML?.(el(`<img ${bad}>`))).toBeNull();
        }
    });

    it("with no dimensions it renders no empty attributes (the HTML stays clean)", () => {
        const a = attrs();
        expect(a.w?.renderHTML?.({ w: null })).toEqual({});
        expect(a.h?.renderHTML?.({ h: null })).toEqual({});
    });

    it("the display `width` and the intrinsic `w` are separate contracts", () => {
        const a = attrs();
        // width is a CSS string (a user resize); w is the original's pixel count.
        const img = el('<img data-file-id="f1" width="640px" data-w="1600" data-h="900">');
        expect(a.width?.parseHTML?.(img)).toBe("640px");
        expect(a.w?.parseHTML?.(img)).toBe(1600);
        expect(a.width?.renderHTML?.({ width: "640px" })).toMatchObject({ width: "640px" });
    });
});
