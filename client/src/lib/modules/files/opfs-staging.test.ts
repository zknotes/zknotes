import { describe, expect, it } from "vitest";
import { isStagingComplete, LEGACY_BLOB_MAX_BYTES, shouldWarnNoResume } from "./opfs-staging";

describe("opfs-staging helpers", () => {
    it("isStagingComplete when bytes match plain_size", () => {
        expect(
            isStagingComplete({
                staging_id: "loc-1",
                staging_bytes_written: 100,
                plain_size: 100,
            }),
        ).toBe(true);
        expect(
            isStagingComplete({
                staging_id: "loc-1",
                staging_bytes_written: 50,
                plain_size: 100,
            }),
        ).toBe(false);
    });

    it("shouldWarnNoResume for large files without OPFS", () => {
        expect(shouldWarnNoResume("none", LEGACY_BLOB_MAX_BYTES + 1)).toBe(true);
        expect(shouldWarnNoResume("sync", LEGACY_BLOB_MAX_BYTES + 1)).toBe(false);
        expect(shouldWarnNoResume("none", 100)).toBe(false);
    });
});
