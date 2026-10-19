import { describe, expect, it } from "vitest";
import { ApiError } from "$lib/core/api/client";
import { isPermanentPushError } from "./push";

// A push failure is "permanent" — park the item instead of retrying — only on the server's own
// verdict. Network failures, timeouts and stray objects carrying a `status` are not verdicts.
describe("isPermanentPushError", () => {
    it("is true for a 4xx the server gives about the request itself", () => {
        expect(isPermanentPushError(new ApiError("bad", 400))).toBe(true);
        expect(isPermanentPushError(new ApiError("payload_too_large", 413))).toBe(true);
        expect(isPermanentPushError(new ApiError("conflict", 409))).toBe(true);
    });

    it("is false for timing statuses, server errors and anything that is not an ApiError", () => {
        expect(isPermanentPushError(new ApiError("timeout", 408))).toBe(false);
        expect(isPermanentPushError(new ApiError("slow down", 429))).toBe(false);
        expect(isPermanentPushError(new ApiError("down", 500))).toBe(false);
        expect(isPermanentPushError(new TypeError("Failed to fetch"))).toBe(false);
        expect(isPermanentPushError({ status: 400 })).toBe(false);
        expect(isPermanentPushError(undefined)).toBe(false);
    });
});
