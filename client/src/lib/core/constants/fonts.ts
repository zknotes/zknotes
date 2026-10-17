// The font choices in the editor toolbar. One place of truth for the FontFamily/FontSize popovers and
// for the label lookup. `value` is the literal CSS stored on the textStyle mark;
// "" means "unset" (fall back to the prose default).

export interface FontFamilyOption {
    label: string;
    // A CSS font-family stack, or "" to remove the mark.
    value: string;
}

export const FONT_FAMILIES: FontFamilyOption[] = [
    { label: "Default", value: "" },
    {
        label: "Sans Serif",
        value: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    },
    { label: "Serif", value: "Georgia, Cambria, 'Times New Roman', Times, serif" },
    {
        label: "Monospace",
        value: "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    },
    { label: "Rounded", value: "'Trebuchet MS', 'Segoe UI', Verdana, sans-serif" },
];

// The font sizes in px. "" means "unset" (fall back to the prose default).
// The stepper (+/−) in the FontSize popover walks every explicit value.
export const FONT_SIZES: { label: string; value: string }[] = [
    { label: "Default", value: "" },
    { label: "8", value: "8px" },
    { label: "9", value: "9px" },
    { label: "10", value: "10px" },
    { label: "11", value: "11px" },
    { label: "12", value: "12px" },
    { label: "14", value: "14px" },
    { label: "16", value: "16px" },
    { label: "18", value: "18px" },
    { label: "20", value: "20px" },
    { label: "24", value: "24px" },
    { label: "30", value: "30px" },
    { label: "36", value: "36px" },
    { label: "42", value: "42px" },
    { label: "48", value: "48px" },
    { label: "60", value: "60px" },
    { label: "72", value: "72px" },
];

// The stepper (+/−) uses the explicit sizes only; Default (unset) is a separate reset in the popover.
export const FONT_SIZE_STEPS = FONT_SIZES.filter((s) => s.value !== "");

// Design default body size (prose `font-size: 1rem` ≈ 16px @ 100% root).
// What is displayed, and the base for a step, when textStyle carries no fontSize mark.
export const FONT_SIZE_DEFAULT_PX = 16;

/** The number in the toolbar/popover: "16" for default/unset, otherwise "8"…"72" (or a custom one). */
export function fontSizeDisplayLabel(value: string | null | undefined): string {
    if (!value) return String(FONT_SIZE_DEFAULT_PX);
    return value.replace(/px$/i, "");
}

/**
 * The index into FONT_SIZE_STEPS for the current textStyle.fontSize.
 * Unset → the 16px default; an unknown size → the nearest step.
 */
export function fontSizeStepIndex(value: string | null | undefined): number {
    const fallback = FONT_SIZE_STEPS.findIndex((s) => s.value === `${FONT_SIZE_DEFAULT_PX}px`);
    const safeFallback = fallback >= 0 ? fallback : 0;

    if (!value) return safeFallback;

    const exact = FONT_SIZE_STEPS.findIndex((s) => s.value === value);
    if (exact >= 0) return exact;

    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return safeFallback;

    let best = safeFallback;
    let bestDist = Infinity;
    for (let i = 0; i < FONT_SIZE_STEPS.length; i++) {
        const step = FONT_SIZE_STEPS[i];
        if (!step) continue;
        const sn = Number.parseFloat(step.value);
        if (!Number.isFinite(sn)) continue;
        const d = Math.abs(sn - n);
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}
