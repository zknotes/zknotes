import { describe, expect, it } from "vitest";
import { parseUserAgent } from "./user-agent";

describe("parseUserAgent", () => {
    it("parses Chrome on Linux desktop", () => {
        const ua =
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
        expect(parseUserAgent(ua)).toEqual({
            browser: "Chrome",
            os: "Linux",
            deviceType: "desktop",
            label: "Chrome on Linux",
        });
    });

    it("parses Chrome on Windows", () => {
        const ua =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        expect(parseUserAgent(ua)).toEqual({
            browser: "Chrome",
            os: "Windows",
            deviceType: "desktop",
            label: "Chrome on Windows",
        });
    });

    it("parses Safari on iPhone", () => {
        const ua =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
        expect(parseUserAgent(ua)).toEqual({
            browser: "Safari",
            os: "iOS",
            deviceType: "mobile",
            label: "Safari on iOS",
        });
    });

    it("parses Firefox on macOS", () => {
        const ua =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0";
        expect(parseUserAgent(ua)).toEqual({
            browser: "Firefox",
            os: "macOS",
            deviceType: "desktop",
            label: "Firefox on macOS",
        });
    });

    it("parses Edge on Windows", () => {
        const ua =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
        expect(parseUserAgent(ua)).toEqual({
            browser: "Edge",
            os: "Windows",
            deviceType: "desktop",
            label: "Edge on Windows",
        });
    });

    it("returns unknown for empty input", () => {
        expect(parseUserAgent(null).label).toBe("Unknown device");
        expect(parseUserAgent("").label).toBe("Unknown device");
    });
});
