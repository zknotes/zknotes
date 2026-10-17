import type { TimeFormat } from "$lib/core/stores/datetime-settings.svelte";

export const DEFAULT_CUSTOM_DATE_PATTERN = "DD/MM/YYYY HH:mm";

type ZonedParts = {
    year: string;
    month: string;
    monthPadded: string;
    day: string;
    dayPadded: string;
    hour24: string;
    hour24Padded: string;
    hour12: string;
    hour12Padded: string;
    minute: string;
    minutePadded: string;
    second: string;
    secondPadded: string;
    ampm: string;
};

function pick(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
    return parts.find((p) => p.type === type)?.value ?? "";
}

function getZonedParts(date: Date, timezone: string | undefined): ZonedParts {
    const base: Intl.DateTimeFormatOptions = {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        minute: "numeric",
        second: "numeric",
    };
    if (timezone) base.timeZone = timezone;

    const parts24 = new Intl.DateTimeFormat("en-US", {
        ...base,
        hour: "numeric",
        hour12: false,
    }).formatToParts(date);
    const parts12 = new Intl.DateTimeFormat("en-US", {
        ...base,
        hour: "numeric",
        hour12: true,
    }).formatToParts(date);

    const year = pick(parts24, "year");
    const month = pick(parts24, "month");
    const day = pick(parts24, "day");
    const hour24 = pick(parts24, "hour");
    const minute = pick(parts24, "minute");
    const second = pick(parts24, "second");
    const hour12 = pick(parts12, "hour");
    const ampm = pick(parts12, "dayPeriod").toUpperCase();

    return {
        year,
        month,
        monthPadded: month.padStart(2, "0"),
        day,
        dayPadded: day.padStart(2, "0"),
        hour24,
        hour24Padded: hour24.padStart(2, "0"),
        hour12,
        hour12Padded: hour12.padStart(2, "0"),
        minute,
        minutePadded: minute.padStart(2, "0"),
        second,
        secondPadded: second.padStart(2, "0"),
        ampm: ampm || (Number(hour24) >= 12 ? "PM" : "AM"),
    };
}

/** Token substitution in the user's pattern (DD, MM, YYYY, HH, mm, …). */
export function formatWithDatePattern(
    tsSeconds: number,
    pattern: string,
    _timeFormat: TimeFormat,
    timezone: string,
): string {
    const trimmed = pattern.trim() || DEFAULT_CUSTOM_DATE_PATTERN;
    const date = new Date(tsSeconds * 1000);
    const tz = timezone !== "system" ? timezone : undefined;
    const p = getZonedParts(date, tz);

    const tokens: [string, string][] = [
        ["YYYY", p.year],
        ["YY", p.year.slice(-2)],
        ["MM", p.monthPadded],
        ["DD", p.dayPadded],
        ["HH", p.hour24Padded],
        ["hh", p.hour12Padded],
        ["mm", p.minutePadded],
        ["ss", p.secondPadded],
        ["A", p.ampm],
        ["M", p.month],
        ["D", p.day],
        ["H", p.hour24],
        ["h", p.hour12],
        ["m", p.minute],
        ["s", p.second],
    ];

    let out = trimmed;
    for (const [token, value] of tokens) {
        out = out.split(token).join(value);
    }
    return out;
}
