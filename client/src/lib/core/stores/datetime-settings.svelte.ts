import { browser } from "$app/environment";
import { DEFAULT_CUSTOM_DATE_PATTERN } from "$lib/core/utils/date-pattern";

export type TimeFormat = "system" | "24h" | "12h";
export type DateFormat =
    | "system"
    | "dd-mm-yyyy"
    | "dd-mm-yyyy-dot"
    | "mm-dd-yyyy"
    | "yyyy-mm-dd"
    | "custom";

const TIME_FORMAT_KEY = "zknotes:datetime-time-format";
const DATE_FORMAT_KEY = "zknotes:datetime-date-format";
const CUSTOM_PATTERN_KEY = "zknotes:datetime-custom-pattern";
const TIMEZONE_KEY = "zknotes:datetime-timezone";

const TIME_FORMATS = new Set<TimeFormat>(["system", "24h", "12h"]);
const DATE_FORMATS = new Set<DateFormat>([
    "system",
    "dd-mm-yyyy",
    "dd-mm-yyyy-dot",
    "mm-dd-yyyy",
    "yyyy-mm-dd",
    "custom",
]);

function loadTimeFormat(): TimeFormat {
    if (!browser) return "system";
    const v = localStorage.getItem(TIME_FORMAT_KEY);
    return v && TIME_FORMATS.has(v as TimeFormat) ? (v as TimeFormat) : "system";
}

function loadDateFormat(): DateFormat {
    if (!browser) return "system";
    const v = localStorage.getItem(DATE_FORMAT_KEY);
    return v && DATE_FORMATS.has(v as DateFormat) ? (v as DateFormat) : "system";
}

function loadCustomPattern(): string {
    if (!browser) return DEFAULT_CUSTOM_DATE_PATTERN;
    return localStorage.getItem(CUSTOM_PATTERN_KEY) ?? DEFAULT_CUSTOM_DATE_PATTERN;
}

function loadTimezone(): string {
    if (!browser) return "system";
    const v = localStorage.getItem(TIMEZONE_KEY);
    return v ?? "system";
}

// Never to the server — each device has its own date/time format.
class DateTimeSettingsStore {
    timeFormat = $state<TimeFormat>(loadTimeFormat());
    dateFormat = $state<DateFormat>(loadDateFormat());
    customDatePattern = $state<string>(loadCustomPattern());
    timezone = $state<string>(loadTimezone());

    setTimeFormat(v: TimeFormat) {
        this.timeFormat = v;
        if (browser) localStorage.setItem(TIME_FORMAT_KEY, v);
    }

    setDateFormat(v: DateFormat) {
        this.dateFormat = v;
        if (browser) localStorage.setItem(DATE_FORMAT_KEY, v);
    }

    setCustomDatePattern(v: string) {
        this.customDatePattern = v;
        if (browser) localStorage.setItem(CUSTOM_PATTERN_KEY, v);
    }

    setTimezone(v: string) {
        this.timezone = v;
        if (browser) localStorage.setItem(TIMEZONE_KEY, v);
    }

    /** A reset on logout/delete account — localStorage is per-browser, not per-account. */
    reset() {
        this.timeFormat = "system";
        this.dateFormat = "system";
        this.customDatePattern = DEFAULT_CUSTOM_DATE_PATTERN;
        this.timezone = "system";
        if (browser) {
            localStorage.removeItem(TIME_FORMAT_KEY);
            localStorage.removeItem(DATE_FORMAT_KEY);
            localStorage.removeItem(CUSTOM_PATTERN_KEY);
            localStorage.removeItem(TIMEZONE_KEY);
        }
    }
}

export const dateTimeSettings = new DateTimeSettingsStore();
