import {
    loadPersisted,
    rawStringSerde,
    STORAGE_KEYS,
    savePersisted,
} from "$lib/core/utils/persisted";

export type Theme = "dark" | "light" | "warm" | "ocean" | "midnight";

const ALL_THEME_CLASSES = ["dark", "theme-warm", "theme-ocean", "theme-midnight"] as const;

const THEME_CLASSES: Record<Theme, string[]> = {
    dark: ["dark"],
    light: [],
    warm: ["theme-warm"],
    ocean: ["theme-ocean"],
    midnight: ["dark", "theme-midnight"],
};

class ThemeStore {
    private theme = $state<Theme>("dark");

    private getInitialTheme(): Theme {
        if (typeof window === "undefined") return "dark";
        const stored = loadPersisted<string>(STORAGE_KEYS.theme, "", rawStringSerde);
        if (
            stored === "dark" ||
            stored === "light" ||
            stored === "warm" ||
            stored === "ocean" ||
            stored === "midnight"
        ) {
            return stored;
        }
        if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
        return "light";
    }

    private applyTheme(t: Theme): void {
        this.theme = t;
        if (typeof document !== "undefined") {
            const el = document.documentElement;
            for (const c of ALL_THEME_CLASSES) el.classList.remove(c);
            for (const c of THEME_CLASSES[t]) el.classList.add(c);
        }
        savePersisted(STORAGE_KEYS.theme, t, rawStringSerde);
    }

    init = (): void => {
        this.applyTheme(this.getInitialTheme());
    };

    set = (t: Theme): void => {
        this.applyTheme(t);
    };

    get current(): Theme {
        return this.theme;
    }
}

export const themeStore = new ThemeStore();
