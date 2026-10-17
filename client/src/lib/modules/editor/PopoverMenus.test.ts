import { describe, expect, it } from "vitest";
import { PopoverMenus, TABLE_MENU_IDS, isTableMenuOpen } from "./PopoverMenus.svelte";

describe("PopoverMenus", () => {
    it("toggling the same id closes it", () => {
        const m = new PopoverMenus();
        const anchor = {} as HTMLElement;
        m.toggle("heading", anchor);
        expect(m.isOpen("heading")).toBe(true);
        expect(m.anchor("heading")).toBe(anchor);
        m.toggle("heading");
        expect(m.isOpen("heading")).toBe(false);
    });

    it("toggling another id switches active", () => {
        const m = new PopoverMenus();
        m.toggle("emoji");
        m.toggle("link");
        expect(m.isOpen("emoji")).toBe(false);
        expect(m.isOpen("link")).toBe(true);
    });

    it("close(id) is a no-op for an inactive id", () => {
        const m = new PopoverMenus();
        m.toggle("color");
        m.close("highlight");
        expect(m.isOpen("color")).toBe(true);
        m.close("color");
        expect(m.isOpen("color")).toBe(false);
    });

    it("closeAll clears active", () => {
        const m = new PopoverMenus();
        m.toggle("insert");
        m.closeAll();
        expect(m.active).toBeNull();
    });

    it("TABLE_MENU_IDS i isTableMenuOpen", () => {
        const m = new PopoverMenus();

        expect(isTableMenuOpen(m)).toBe(false);

        m.toggle("table");
        expect(isTableMenuOpen(m)).toBe(true);
        expect(TABLE_MENU_IDS.includes("table")).toBe(true);

        m.toggle("tableRow");
        expect(isTableMenuOpen(m)).toBe(true);

        m.toggle("heading");
        expect(isTableMenuOpen(m)).toBe(false);
    });
});
