import {
    loadPersisted,
    rawStringSerde,
    STORAGE_KEYS,
    savePersisted,
} from "$lib/core/utils/persisted";

export type UiZoomLevel =
    | "auto"
    | "80"
    | "100"
    | "120"
    | "140"
    | "160"
    | "180"
    | "200"
    | "220"
    | "240";

const ZOOM_LEVELS: UiZoomLevel[] = [
    "auto",
    "80",
    "100",
    "120",
    "140",
    "160",
    "180",
    "200",
    "220",
    "240",
];

class UiZoomStore {
    private level = $state<UiZoomLevel>("auto");

    private getInitialLevel(): UiZoomLevel {
        if (typeof window === "undefined") return "auto";
        const stored = loadPersisted<string>(STORAGE_KEYS.uiZoom, "", rawStringSerde);
        return (ZOOM_LEVELS as string[]).includes(stored) ? (stored as UiZoomLevel) : "auto";
    }

    private applyLevel(level: UiZoomLevel): void {
        this.level = level;
        if (typeof document !== "undefined") {
            // "auto" sets nothing — the CSS @media rule for large screens (app.css) still applies.
            // An explicit level always beats that rule, because an inline style wins in the cascade.
            //
            // --ui-zoom-factor tracks the real scale (1 = 100%). The app menu (Zoom +/−) freezes the
            // factor when it opens and counter-scales itself while it is open — see SidebarAppMenu —
            // so the buttons do not jump out from under the cursor.
            if (level === "auto") {
                document.documentElement.style.fontSize = "";
                document.documentElement.style.removeProperty("--ui-zoom-factor");
            } else {
                document.documentElement.style.fontSize = `${level}%`;
                document.documentElement.style.setProperty(
                    "--ui-zoom-factor",
                    String(Number(level) / 100),
                );
            }
        }
        savePersisted(STORAGE_KEYS.uiZoom, level, rawStringSerde);
    }

    init = (): void => {
        this.applyLevel(this.getInitialLevel());
    };

    set = (level: UiZoomLevel): void => {
        this.applyLevel(level);
    };

    get current(): UiZoomLevel {
        return this.level;
    }

    /**
     * The real UI scale (1 = 100%). For "auto" it follows app.css's @media (≥1536px → 1.125).
     * It is used for the freeze counter-scale while the Zoom menu is open.
     */
    get factor(): number {
        if (this.level === "auto") {
            if (typeof window === "undefined") return 1;
            return window.matchMedia("(min-width: 1536px)").matches ? 1.125 : 1;
        }
        return Number(this.level) / 100;
    }
}

export const uiZoomStore = new UiZoomStore();
