import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The date/time, outline and pin stores used to call localStorage directly: a blocked storage
// (Safari private mode, a locked-down profile) threw out of their setters into the click handler,
// and their keys were not in STORAGE_KEYS. They now go through the one wrapper. What must not
// change is the stored format, so a value written by an older build still reads back.

beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("date/time settings", () => {
    it("reads the raw strings an older build stored", async () => {
        localStorage.setItem("zknotes:datetime-time-format", "24h");
        localStorage.setItem("zknotes:datetime-date-format", "yyyy-mm-dd");
        localStorage.setItem("zknotes:datetime-timezone", "Europe/Zagreb");
        const { dateTimeSettings } = await import("./datetime-settings.svelte");
        expect(dateTimeSettings.timeFormat).toBe("24h");
        expect(dateTimeSettings.dateFormat).toBe("yyyy-mm-dd");
        expect(dateTimeSettings.timezone).toBe("Europe/Zagreb");
    });

    it("writes raw strings back, and survives a storage that throws", async () => {
        const { dateTimeSettings } = await import("./datetime-settings.svelte");
        dateTimeSettings.setTimeFormat("12h");
        expect(localStorage.getItem("zknotes:datetime-time-format")).toBe("12h");

        // A locked-down storage: every write throws (Safari private mode behaves like this).
        vi.stubGlobal("localStorage", {
            getItem: () => null,
            setItem: () => {
                throw new DOMException("blocked", "SecurityError");
            },
            removeItem: () => {
                throw new DOMException("blocked", "SecurityError");
            },
        });
        expect(() => dateTimeSettings.setTimezone("UTC")).not.toThrow();
        expect(dateTimeSettings.timezone).toBe("UTC");
        expect(() => dateTimeSettings.reset()).not.toThrow();
        vi.unstubAllGlobals();
    });
});

describe("outline panel", () => {
    it("keeps the '1'/'0' flag and the numeric width as before", async () => {
        localStorage.setItem("zknotes:outline-visible", "1");
        localStorage.setItem("zknotes:outline-width", "300");
        const { outlineStore } = await import("./outline.svelte");
        expect(outlineStore.visible).toBe(true);
        expect(outlineStore.width).toBe(300);

        outlineStore.hide();
        expect(localStorage.getItem("zknotes:outline-visible")).toBe("0");
        outlineStore.setWidth(260);
        expect(localStorage.getItem("zknotes:outline-width")).toBe("260");
    });
});

describe("pinned items", () => {
    it("reads the JSON array as before, and ignores a corrupt value", async () => {
        localStorage.setItem("zknotes:pinned-items", JSON.stringify(["a", "b"]));
        const { pinManager } = await import("../files/pin-manager-state.svelte");
        expect(pinManager.roots).toEqual(["a", "b"]);

        vi.resetModules();
        localStorage.setItem("zknotes:pinned-items", "{not json");
        const fresh = await import("../files/pin-manager-state.svelte");
        expect(fresh.pinManager.roots).toEqual([]);
    });
});
