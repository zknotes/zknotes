import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/core/api/shares", () => ({
    createShare: vi.fn(),
    listShares: vi.fn(),
    revokeShare: vi.fn(),
}));
vi.mock("$lib/core/workers/crypto-rpc", () => ({ wrapItemKeyForShareTask: vi.fn() }));

const { formatShareError, isShareListEntryActive, shareStatus, shareTtlOptions } = await import(
    "./share-service"
);
import type { ShareListEntry } from "$lib/core/api/shares";

// Saas spec 156 (package G): the share module's pure helpers had no test file at all.
const entry = (o: Partial<ShareListEntry>): ShareListEntry =>
    ({
        id: "s",
        source_item_id: "n",
        created_at: 0,
        expires_at: null,
        revoked_at: null,
        last_viewed_at: null,
        view_count: 0,
        max_views: null,
        needs_password: false,
        source_deleted: false,
        attachment_count: 0,
        ...o,
    }) as ShareListEntry;

afterEach(() => vi.useRealTimers());

describe("shareTtlOptions", () => {
    it("offers only the TTLs the server allows; 0 means nothing yet", () => {
        expect(shareTtlOptions(0)).toEqual([]);
        expect(shareTtlOptions(24 * 3600).map((o) => o.label)).toEqual(["1 hour", "24 hours"]);
        expect(shareTtlOptions(7 * 24 * 3600)).toHaveLength(3);
    });
});

describe("isShareListEntryActive", () => {
    it("revoked, source-deleted or expired links are not active", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_800_000_000_000));
        expect(isShareListEntryActive(entry({}))).toBe(true);
        expect(isShareListEntryActive(entry({ revoked_at: 1 }))).toBe(false);
        expect(isShareListEntryActive(entry({ source_deleted: true }))).toBe(false);
        expect(isShareListEntryActive(entry({ expires_at: 1_800_000_000 - 1 }))).toBe(false);
        expect(isShareListEntryActive(entry({ expires_at: 1_800_000_000 + 60 }))).toBe(true);
    });
});

describe("formatShareError", () => {
    it("knows the server's codes and falls back to the code or a generic line", () => {
        expect(formatShareError("share_exists")).toContain("Replace link");
        expect(formatShareError("too_many_shares")).toContain("maximum");
        expect(formatShareError("weird_code")).toBe("weird_code");
        expect(formatShareError("")).toBe("Failed to create link");
    });
});

describe("shareStatus", () => {
    it("ranks a deleted source over a revoke over an expiry", () => {
        const now = 1_800_000_000_000;
        expect(shareStatus(entry({}), now)).toBe("active");
        expect(shareStatus(entry({ expires_at: 1_800_000_000 - 1 }), now)).toBe("expired");
        expect(shareStatus(entry({ expires_at: 1_800_000_000 - 1, revoked_at: 5 }), now)).toBe(
            "revoked",
        );
        expect(shareStatus(entry({ revoked_at: 5, source_deleted: true }), now)).toBe(
            "source_deleted",
        );
    });
});
