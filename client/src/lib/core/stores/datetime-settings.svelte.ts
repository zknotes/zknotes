import { DEFAULT_CUSTOM_DATE_PATTERN } from "$lib/core/utils/date-pattern";
import {
    loadPersisted,
    rawStringSerde,
    removePersisted,
    savePersisted,
    STORAGE_KEYS,
} from "$lib/core/utils/persisted";

export type TimeFormat = "system" | "24h" | "12h";
export type DateFormat =
    | "system"
    | "dd-mm-yyyy"
    | "dd-mm-yyyy-dot"
    | "mm-dd-yyyy"
    | "yyyy-mm-dd"
    | "custom";

// Through the one localStorage wrapper (SSR-safe, try/catch): a blocked storage used to throw out
// of these setters into the click handler. The stored format is unchanged — raw strings.
const TIME_FORMAT_KEY = STORAGE_KEYS.dateTimeTimeFormat;
const DATE_FORMAT_KEY = STORAGE_KEYS.dateTimeDateFormat;
const CUSTOM_PATTERN_KEY = STORAGE_KEYS.dateTimeCustomPattern;
const TIMEZONE_KEY = STORAGE_KEYS.dateTimeTimezone;
// `getItem` semantics: null when the key is absent (an empty string stays an empty string).
const MISSING = "\u0000missing";
const raw = (key: string): string | null => {
    const v = loadPersisted(key, MISSING, rawStringSerde);
    return v === MISSING ? null : v;
};

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
    const v = raw(TIME_FORMAT_KEY);
    return v && TIME_FORMATS.has(v as TimeFormat) ? (v as TimeFormat) : "system";
}

function loadDateFormat(): DateFormat {
    const v = raw(DATE_FORMAT_KEY);
    return v && DATE_FORMATS.has(v as DateFormat) ? (v as DateFormat) : "system";
}

function loadCustomPattern(): string {
    return raw(CUSTOM_PATTERN_KEY) ?? DEFAULT_CUSTOM_DATE_PATTERN;
}

function loadTimezone(): string {
    return raw(TIMEZONE_KEY) ?? "system";
}

// Never to the server — each device has its own date/time format.
class DateTimeSettingsStore {
    timeFormat = $state<TimeFormat>(loadTimeFormat());
    dateFormat = $state<DateFormat>(loadDateFormat());
    customDatePattern = $state<string>(loadCustomPattern());
    timezone = $state<string>(loadTimezone());

    setTimeFormat(v: TimeFormat) {
        this.timeFormat = v;
        savePersisted(TIME_FORMAT_KEY, v, rawStringSerde);
    }

    setDateFormat(v: DateFormat) {
        this.dateFormat = v;
        savePersisted(DATE_FORMAT_KEY, v, rawStringSerde);
    }

    setCustomDatePattern(v: string) {
        this.customDatePattern = v;
        savePersisted(CUSTOM_PATTERN_KEY, v, rawStringSerde);
    }

    setTimezone(v: string) {
        this.timezone = v;
        savePersisted(TIMEZONE_KEY, v, rawStringSerde);
    }

    /** A reset on logout/delete account — localStorage is per-browser, not per-account. */
    reset() {
        this.timeFormat = "system";
        this.dateFormat = "system";
        this.customDatePattern = DEFAULT_CUSTOM_DATE_PATTERN;
        this.timezone = "system";
        for (const key of [TIME_FORMAT_KEY, DATE_FORMAT_KEY, CUSTOM_PATTERN_KEY, TIMEZONE_KEY]) {
            removePersisted(key);
        }
    }
}

export const dateTimeSettings = new DateTimeSettingsStore();
