export type DeviceType = "desktop" | "mobile" | "tablet" | "unknown";

export interface ParsedUserAgent {
    browser: string;
    os: string;
    deviceType: DeviceType;
    /** A short title for display, "Chrome on Linux" for instance. */
    label: string;
}

function detectBrowser(ua: string): string {
    if (/Edg\//i.test(ua)) return "Edge";
    if (/OPR\/|Opera/i.test(ua)) return "Opera";
    if (/Firefox\//i.test(ua)) return "Firefox";
    if (/Chrome\//i.test(ua)) return "Chrome";
    if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return "Safari";
    if (/MSIE |Trident\//i.test(ua)) return "Internet Explorer";
    return "Unknown browser";
}

function detectOs(ua: string): string {
    if (/iPhone|iPod/i.test(ua)) return "iOS";
    if (/iPad/i.test(ua)) return "iPadOS";
    if (/Android/i.test(ua)) return "Android";
    if (/CrOS/i.test(ua)) return "ChromeOS";
    if (/Windows NT/i.test(ua)) return "Windows";
    if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
    if (/Linux/i.test(ua)) return "Linux";
    return "Unknown OS";
}

function detectDeviceType(ua: string): DeviceType {
    if (/iPad|Tablet/i.test(ua)) return "tablet";
    if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return "tablet";
    if (/Mobile|iPhone|iPod|Android/i.test(ua)) return "mobile";
    if (/Windows NT|Mac OS X|Macintosh|Linux|CrOS|X11/i.test(ua)) return "desktop";
    return "unknown";
}

const UNKNOWN: ParsedUserAgent = {
    browser: "Unknown browser",
    os: "Unknown device",
    deviceType: "unknown",
    label: "Unknown device",
};

/** Parses a raw User-Agent into a readable title and the metadata the session list shows. */
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
    const trimmed = ua?.trim();
    if (!trimmed) return UNKNOWN;

    const browser = detectBrowser(trimmed);
    const os = detectOs(trimmed);
    const deviceType = detectDeviceType(trimmed);

    return {
        browser,
        os,
        deviceType,
        label: `${browser} on ${os}`,
    };
}
