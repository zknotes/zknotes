/**
 * The last Settings tab in this browser session (sessionStorage).
 * The gear in the sidebar opens that tab instead of always going to Account.
 */

import { browser } from "$app/environment";

const KEY = "cn_settings_last_tab";
const DEFAULT_HREF = "/settings";

function isSettingsHref(value: string): boolean {
    return value === "/settings" || value.startsWith("/settings/");
}

// Coming back to Settings must not drop the user on the delete-account screen.
function isDeleteAccountHref(value: string): boolean {
    return value === "/settings/delete-account";
}

function loadHref(): string {
    if (!browser) return DEFAULT_HREF;
    try {
        const raw = sessionStorage.getItem(KEY);
        if (raw && isSettingsHref(raw)) return raw;
    } catch {
        // private mode / disabled storage
    }
    return DEFAULT_HREF;
}

function saveHref(href: string): void {
    if (!browser) return;
    try {
        sessionStorage.setItem(KEY, href);
    } catch {
        // best-effort
    }
}

class SettingsLastTabStore {
    /** The path for the Settings gear: `/settings` or `/settings/<tab>`. */
    href = $state(loadHref());

    /** Remember the current Settings path (call it when the active tab changes). */
    remember(href: string): void {
        if (!isSettingsHref(href)) return;
        if (isDeleteAccountHref(href)) return;
        if (this.href === href) return;
        this.href = href;
        saveHref(href);
    }
}

export const settingsLastTabStore = new SettingsLastTabStore();
