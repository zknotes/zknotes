/**
 * The only raw localStorage wrapper — an SSR-safe try/catch + (de)serialisation.
 * Every module that persists UI state goes through these helpers; the key names are centralised in
 * STORAGE_KEYS (the folder-expand prefix lives in utils/expanded-folders).
 *
 * IMPORTANT: the format of the stored values has to stay identical to the existing one —
 * "theme" and "zknotes_user_id" are raw strings (with no JSON quotes),
 * the recents lists are JSON arrays.
 */

export const STORAGE_KEYS = {
    /** "dark" | "light" — a raw string. */
    theme: "theme",
    /** JSON string[] — the IDs of the recently opened notes. */
    recentNotes: "cn_recent_notes",
    /** A JSON string[] — the recently used emoji. */
    recentEmojis: "cn_recent_emojis",
    /** A raw string — the user id, for detecting a change of user (and clearing the IDB cache). */
    storedUserId: "zknotes_user_id",
    /**
     * A raw string — the email of the last successful sign-in.
     * Case-folded (`toLowerCase`). It is not cleared on logout or session expiry, exactly like
     * storedUserId.
     */
    storedEmail: "zknotes_user_email",
    /** JSON string[] — the pinned item IDs (selective sync). */
    pinnedItems: "zknotes:pinned-items",
    /** A raw string — the outcome of navigator.storage.persist() ("persisted"|"denied"|"unsupported"). */
    persistentStorage: "cn_persistent_storage",
    /** A raw string — "true" when the user changed and we have not yet cleared the database (awaiting a pull). */
    pendingClearForUser: "cn_pending_clear_for_user",
    /** A raw string — "true" once the one-off tip about @ linking notes has been shown. */
    noteLinkTipSeen: "cn_note_link_tip_seen",
    /**
     * "auto" | "80" | "100" | "120" | "140" | "160" | "180" | "200" | "220" | "240" — a raw string, the UI zoom.
     * The early FOUC script in app.html hardcodes the same key (`cn_ui_zoom`) — change them together.
     */
    uiZoom: "cn_ui_zoom",
    /**
     * The app sidebar's width in px (a JSON number). Per browser; it is not synced to the server —
     * a layout preference like the ui zoom.
     */
    sidebarWidth: "cn_sidebar_width",
    /** Raw strings — the per-device date/time preferences (never synced). */
    dateTimeTimeFormat: "zknotes:datetime-time-format",
    dateTimeDateFormat: "zknotes:datetime-date-format",
    dateTimeCustomPattern: "zknotes:datetime-custom-pattern",
    dateTimeTimezone: "zknotes:datetime-timezone",
    /** "1" | "0" — whether the outline panel is open (sticky, like Word's navigation pane). */
    outlineVisible: "zknotes:outline-visible",
    /** A raw number string — the outline panel's width in px. */
    outlineWidth: "zknotes:outline-width",
} as const;

interface Serde<T> {
    serialize: (value: T) => string;
    deserialize: (raw: string) => T;
}

/** Loads a JSON-serialised value; it falls back on an error, under SSR, or for a missing key. */
export function loadPersisted<T>(key: string, fallback: T, serde?: Serde<T>): T {
    if (typeof localStorage === "undefined") return fallback;
    try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        return serde ? serde.deserialize(raw) : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
}

export function savePersisted<T>(key: string, value: T, serde?: Serde<T>): void {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(key, serde ? serde.serialize(value) : JSON.stringify(value));
    } catch {
        // quota/private-mode — persistence is best-effort
    }
}

/** The serde for values historically stored as a raw string (with no JSON). */
export const rawStringSerde: Serde<string> = {
    serialize: (v) => v,
    deserialize: (raw) => raw,
};

/** Removes a key; SSR-safe and best-effort like the other two. */
export function removePersisted(key: string): void {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.removeItem(key);
    } catch {
        // best-effort
    }
}
