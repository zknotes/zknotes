// The shared display formatters — the only definition (previously duplicated across
// the files/trash/starred/recent pages, FilePicker, FileDetailPanel, EditorHeader).

import {
    FileArchive,
    FileAudio,
    File as FileIcon,
    FileImage,
    FileText,
    FileVideo,
} from "lucide-svelte";
import type { DateFormat, TimeFormat } from "$lib/core/stores/datetime-settings.svelte";
import { dateTimeSettings } from "$lib/core/stores/datetime-settings.svelte";
import type { LucideIcon } from "$lib/core/types/icons";
import { formatWithDatePattern } from "$lib/core/utils/date-pattern";

/** A size in B/KB/MB; `null` or `undefined` → "—". */
export function humanSize(bytes?: number | null): string {
    if (bytes == null) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** A compact variant for storage totals (KB/MB/GB, with no B level). */
export function humanSizeShort(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
}

/** Relative time from a unix-second timestamp ("5m ago"); falsy → "now". */
export function relativeTime(tsSeconds?: number | null): string {
    if (!tsSeconds) return "now";
    const s = Math.max(1, Math.round(Date.now() / 1000 - tsSeconds));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

function localeForDateFormat(dateFormat: DateFormat): string | undefined {
    switch (dateFormat) {
        case "dd-mm-yyyy":
            return "en-GB";
        case "mm-dd-yyyy":
            return "en-US";
        case "yyyy-mm-dd":
            return "sv-SE";
        default:
            return undefined;
    }
}

function buildDateTimeOptions(
    timeFormat: TimeFormat,
    timezone: string,
    parts: "full" | "time" | "short-date",
): Intl.DateTimeFormatOptions {
    const options: Intl.DateTimeFormatOptions = {};
    if (timezone !== "system") options.timeZone = timezone;
    if (timeFormat === "24h") options.hour12 = false;
    else if (timeFormat === "12h") options.hour12 = true;

    if (parts === "time") {
        options.hour = "2-digit";
        options.minute = "2-digit";
    } else if (parts === "short-date") {
        options.month = "short";
        options.day = "numeric";
    } else if (parts === "full") {
        options.year = "numeric";
        options.month = "numeric";
        options.day = "numeric";
        options.hour = "2-digit";
        options.minute = "2-digit";
    }
    return options;
}

/** An absolute date and time from unix seconds — it honours Preferences → Date & time. */
export function formatDate(tsSeconds: number): string {
    const { timeFormat, dateFormat, customDatePattern, timezone } = dateTimeSettings;
    if (dateFormat === "custom") {
        return formatWithDatePattern(tsSeconds, customDatePattern, timeFormat, timezone);
    }
    if (dateFormat === "dd-mm-yyyy-dot") {
        return formatWithDatePattern(tsSeconds, "DD.MM.YYYY HH:mm", timeFormat, timezone);
    }
    const locale = localeForDateFormat(dateFormat);
    const options = buildDateTimeOptions(timeFormat, timezone, "full");
    return new Intl.DateTimeFormat(locale, options).format(new Date(tsSeconds * 1000));
}

/** The time only (HH:MM) — it honours Preferences → Date & time. */
export function formatTime(tsSeconds: number): string {
    const { timeFormat, timezone } = dateTimeSettings;
    const options = buildDateTimeOptions(timeFormat, timezone, "time");
    return new Intl.DateTimeFormat(undefined, options).format(new Date(tsSeconds * 1000));
}

/** A short date ("Jan 5", say) — it honours Preferences → Date & time. */
export function formatShortDate(tsSeconds: number): string {
    const { dateFormat, timeFormat, timezone } = dateTimeSettings;
    if (dateFormat === "dd-mm-yyyy-dot") {
        return formatWithDatePattern(tsSeconds, "DD.MM.", timeFormat, timezone);
    }
    const locale = localeForDateFormat(dateFormat);
    const options = buildDateTimeOptions("system", timezone, "short-date");
    return new Intl.DateTimeFormat(locale, options).format(new Date(tsSeconds * 1000));
}

/** A date with the year, without the time — it honours Preferences → Date & time. */
export function formatDateOnly(tsSeconds: number): string {
    const { dateFormat, timeFormat, timezone } = dateTimeSettings;
    if (dateFormat === "dd-mm-yyyy-dot") {
        return formatWithDatePattern(tsSeconds, "DD.MM.YYYY", timeFormat, timezone);
    }
    const locale = localeForDateFormat(dateFormat);
    const options: Intl.DateTimeFormatOptions = {
        year: "numeric",
        month: "short",
        day: "numeric",
    };
    if (timezone !== "system") options.timeZone = timezone;
    return new Intl.DateTimeFormat(locale, options).format(new Date(tsSeconds * 1000));
}

/** MIME → the lucide icon file views show. */
export function fileIcon(mime?: string): LucideIcon {
    if (!mime) return FileIcon;
    if (mime.startsWith("image/")) return FileImage;
    if (mime.startsWith("audio/")) return FileAudio;
    if (mime.startsWith("video/")) return FileVideo;
    if (mime === "application/pdf" || mime.startsWith("text/")) return FileText;
    if (mime.includes("zip") || mime.includes("compressed") || mime.includes("tar"))
        return FileArchive;
    return FileIcon;
}

/** How many days files stay in Trash before the auto-purge (kept in step with the API's TRASH_RETENTION_DAYS). */
export const TRASH_RETENTION_DAYS = 30;

/**
 * Computes the retention time left in Trash, for display in the UI.
 * It returns null when deletedAtSec is not given.
 * The optional nowSec parameter allows caching: pass Math.floor(Date.now() / 1000) to avoid repeated
 * calls.
 */
export function trashRetentionLabel(
    deletedAtSec: number | undefined,
    nowSec?: number,
): { deletedText: string; daysLeftText: string } | null {
    if (!deletedAtSec) return null;
    if (nowSec === undefined) nowSec = Math.floor(Date.now() / 1000);
    const elapsedSec = nowSec - deletedAtSec;
    const elapsedDays = Math.floor(elapsedSec / (24 * 3600));
    const daysLeft = Math.max(1, TRASH_RETENTION_DAYS - elapsedDays);

    const deletedText = relativeTime(deletedAtSec);
    const daysLeftText = daysLeft === 1 ? "1 day left" : `${daysLeft} days left`;
    return { deletedText, daysLeftText };
}
