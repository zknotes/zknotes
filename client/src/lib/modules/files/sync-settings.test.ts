import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    detectDefaultPolicy,
    getSyncSettings,
    SMALL_FILE_LIMIT_BYTES,
    setSyncSettings,
    shouldAutoDownload,
} from "./sync-settings";

// A fake localStorage that works without a real browser.
function makeLocalStorage() {
    let store: Record<string, string> = {};
    return {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
            store[key] = value;
        },
        removeItem: (key: string) => {
            delete store[key];
        },
        clear: () => {
            store = {};
        },
    };
}

let ls = makeLocalStorage();

beforeEach(() => {
    ls = makeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    vi.stubGlobal("window", { innerWidth: 1280 });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Desktop)" });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ── detectDefaultPolicy ──────────────────────────────────────────────────────

describe("detectDefaultPolicy", () => {
    it("returns always for desktop viewport (≥768)", () => {
        expect(detectDefaultPolicy()).toBe("always");
    });

    it("returns never for narrow viewport (<768)", () => {
        vi.stubGlobal("window", { innerWidth: 375 });
        expect(detectDefaultPolicy()).toBe("never");
    });

    it("returns never for Android userAgent", () => {
        vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile" });
        expect(detectDefaultPolicy()).toBe("never");
    });

    it("returns never for iPhone userAgent", () => {
        vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17)" });
        expect(detectDefaultPolicy()).toBe("never");
    });
});

// ── getSyncSettings / setSyncSettings ────────────────────────────────────────

describe("getSyncSettings / setSyncSettings", () => {
    it("returns the device default when localStorage is empty", () => {
        const s = getSyncSettings();
        expect(["always", "never", "small-only"]).toContain(s.autoDownload);
    });

    it("returns the policy that was written", () => {
        setSyncSettings({ autoDownload: "small-only" });
        expect(getSyncSettings().autoDownload).toBe("small-only");
    });

    it("setSyncSettings patches the existing settings rather than replacing them", () => {
        setSyncSettings({ autoDownload: "never" });
        setSyncSettings({ autoDownload: "always" });
        expect(getSyncSettings().autoDownload).toBe("always");
    });

    it("it does not throw on invalid JSON in localStorage", () => {
        ls.setItem("zknotes:sync-settings", "INVALID_JSON{{{");
        expect(() => getSyncSettings()).not.toThrow();
    });
});

// ── shouldAutoDownload — the policy × file-size table ───────────────────────

describe("shouldAutoDownload", () => {
    const SMALL = SMALL_FILE_LIMIT_BYTES - 1;
    const EXACT = SMALL_FILE_LIMIT_BYTES;
    const LARGE = SMALL_FILE_LIMIT_BYTES + 1;

    it.each([
        // policy / fileSizeBytes / expected
        ["always", SMALL, true],
        ["always", LARGE, true],
        ["always", null, true],
        ["never", SMALL, false],
        ["never", LARGE, false],
        ["never", null, false],
        ["small-only", SMALL, true],
        ["small-only", EXACT, true],
        ["small-only", LARGE, false],
        ["small-only", null, true],
    ] as const)("policy=%s size=%s → %s", (policy, size, expected) => {
        setSyncSettings({ autoDownload: policy });
        expect(shouldAutoDownload(size)).toBe(expected);
    });
});
