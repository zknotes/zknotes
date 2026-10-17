import { describe, expect, test } from "vitest";
import {
    FONT_SIZE_DEFAULT_PX,
    FONT_SIZE_STEPS,
    fontSizeDisplayLabel,
    fontSizeStepIndex,
} from "./fonts";

describe("fontSizeDisplayLabel", () => {
    test("unset shows design default", () => {
        expect(fontSizeDisplayLabel("")).toBe(String(FONT_SIZE_DEFAULT_PX));
        expect(fontSizeDisplayLabel(null)).toBe(String(FONT_SIZE_DEFAULT_PX));
        expect(fontSizeDisplayLabel(undefined)).toBe(String(FONT_SIZE_DEFAULT_PX));
    });

    test("strips px suffix", () => {
        expect(fontSizeDisplayLabel("14px")).toBe("14");
        expect(fontSizeDisplayLabel("24PX")).toBe("24");
    });
});

describe("fontSizeStepIndex", () => {
    test("unset maps to default 16px step", () => {
        const i = fontSizeStepIndex("");
        expect(FONT_SIZE_STEPS[i]?.value).toBe(`${FONT_SIZE_DEFAULT_PX}px`);
    });

    test("exact match across extended range", () => {
        expect(FONT_SIZE_STEPS[fontSizeStepIndex("8px")]?.value).toBe("8px");
        expect(FONT_SIZE_STEPS[fontSizeStepIndex("12px")]?.value).toBe("12px");
        expect(FONT_SIZE_STEPS[fontSizeStepIndex("72px")]?.value).toBe("72px");
    });

    test("unknown size snaps to nearest step", () => {
        expect(FONT_SIZE_STEPS[fontSizeStepIndex("13px")]?.value).toBe("12px");
        expect(FONT_SIZE_STEPS[fontSizeStepIndex("22px")]?.value).toBe("20px");
        expect(FONT_SIZE_STEPS[fontSizeStepIndex("100px")]?.value).toBe("72px");
    });

    test("first and last are step boundaries", () => {
        expect(fontSizeStepIndex("8px")).toBe(0);
        expect(fontSizeStepIndex("72px")).toBe(FONT_SIZE_STEPS.length - 1);
    });
});
