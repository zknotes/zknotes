import type { Theme } from "$lib/core/stores/theme.svelte";

/** The colours for the mini chrome preview (settings) and the compact swatch (ThemePicker). */
export interface ThemePreset {
    id: Theme;
    label: string;
    desc: string;
    /** The compact circle in the ThemePicker / the menus */
    swatch: string;
    border: string;
    /** The mini app chrome in the Appearance settings */
    preview: {
        app: string;
        panel: string;
        raised: string;
        stroke: string;
        accent: string;
        text: string;
        textMuted: string;
    };
}

// One place of truth for the list of themes — AppearanceSection and ThemePicker both use it.
// The preview colours are kept in step with the surface/accent tokens in client/src/themes/*.css.
export const THEME_PRESETS: ThemePreset[] = [
    {
        id: "light",
        label: "Light",
        desc: "Bright background, dark text.",
        swatch: "#f3f4f6",
        border: "#dee0e4",
        preview: {
            app: "#f3f4f6",
            panel: "#ffffff",
            raised: "#eaecef",
            stroke: "#dee0e4",
            accent: "#3b6fd4",
            text: "#111827",
            textMuted: "#6b7280",
        },
    },
    {
        id: "warm",
        label: "Warm",
        desc: "Soft cream tones, easy on the eyes.",
        swatch: "#f5f1e6",
        border: "#ddd7c4",
        preview: {
            app: "#f5f1e6",
            panel: "#fbf8ee",
            raised: "#ede7d3",
            stroke: "#ddd7c4",
            accent: "#c47a0a",
            text: "#111827",
            textMuted: "#6b7280",
        },
    },
    {
        id: "ocean",
        label: "Ocean",
        desc: "Cool blue-tinted light theme.",
        swatch: "#d6e8f5",
        border: "#99c4e0",
        preview: {
            app: "#d6e8f5",
            panel: "#eaf4fb",
            raised: "#bdd9ee",
            stroke: "#99c4e0",
            accent: "#2a6bb5",
            text: "#111827",
            textMuted: "#6b7280",
        },
    },
    {
        id: "dark",
        label: "Dark",
        desc: "Dark background, low glare.",
        swatch: "#0f172a",
        border: "#1e293b",
        preview: {
            app: "#020617",
            panel: "#0f172a",
            raised: "#1e293b",
            stroke: "#1e293b",
            accent: "#34d399",
            text: "#f1f5f9",
            textMuted: "#64748b",
        },
    },
    {
        id: "midnight",
        label: "Midnight",
        desc: "Deep near-black dark theme.",
        swatch: "#0d1030",
        border: "#232756",
        preview: {
            app: "#07080f",
            panel: "#0d1030",
            raised: "#151838",
            stroke: "#232756",
            accent: "#a78bfa",
            text: "#f1f5f9",
            textMuted: "#64748b",
        },
    },
];
