// The per-device auto-download policy for file attachments (selective sync).
// Storage: localStorage (a synchronous init, following the theme's pattern). Never to the server — every device
// picks its own policy (a phone = Small only, a desktop = Always).

export type AutoDownloadPolicy = "always" | "never" | "small-only";

export interface SyncSettings {
    autoDownload: AutoDownloadPolicy;
}

const STORAGE_KEY = "zknotes:sync-settings";

// The threshold for "small only" — files at or below this size are downloaded automatically.
// Configurable from .env (no hardcoded important values; they belong in .env).
export const SMALL_FILE_LIMIT_BYTES =
    (Number(import.meta.env.VITE_FILE_SMALL_MB) || 5) * 1024 * 1024;

/**
 * The heuristic: a mobile device (by userAgent or a narrow viewport) → "small-only", desktop →
 * "always". The same breakpoint (768px) as layout.svelte.
 *
 * Mobile used to default to "never", which also blocked the inline images of a note — every one of
 * them is downscaled on upload (modules/files/downscale.ts), so they sit far below
 * SMALL_FILE_LIMIT_BYTES — and a note opened on a phone showed placeholders instead of its images.
 * "small-only" lets those render on their own while large attachments still wait for an explicit
 * action. "never" stays available as a choice; a policy the user picked is read first and this
 * default applies only when nothing was ever saved.
 */
export function detectDefaultPolicy(): AutoDownloadPolicy {
    if (typeof window === "undefined") return "always";
    const isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const isNarrowViewport = window.innerWidth < 768;
    return isMobileUA || isNarrowViewport ? "small-only" : "always";
}

/**
 * Reads the settings from localStorage; on a miss it returns the device default. A stored choice
 * always wins over the default, so changing the default never overrides what a user picked.
 */
export function getSyncSettings(): SyncSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<SyncSettings>;
            if (parsed.autoDownload) return { autoDownload: parsed.autoDownload };
        }
    } catch {
        // localStorage is unavailable (SSR, private mode) → we use the default
    }
    return { autoDownload: detectDefaultPolicy() };
}

/** Stores a patch of the settings; it swallows localStorage errors and never throws. */
export function setSyncSettings(patch: Partial<SyncSettings>): void {
    const current = getSyncSettings();
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
    } catch {
        // localStorage is unavailable — the settings are lost on a reload, which is not fatal
    }
}

/**
 * Should a file of the given size be fetched and cached automatically?
 * A `null` size means unknown → it is treated permissively (download).
 */
export function shouldAutoDownload(fileSizeBytes: number | null): boolean {
    const { autoDownload } = getSyncSettings();
    if (autoDownload === "always") return true;
    if (autoDownload === "never") return false;
    // "small-only": files below the threshold are fetched automatically
    if (fileSizeBytes === null) return true;
    return fileSizeBytes <= SMALL_FILE_LIMIT_BYTES;
}
