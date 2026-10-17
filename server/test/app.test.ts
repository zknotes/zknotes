import { describe, expect, test } from "bun:test";
import { assertCorsOriginForProduction } from "../src/app";

describe("production config guards", () => {
    test("production startup throws without CORS_ORIGIN", () => {
        expect(() => assertCorsOriginForProduction("production", undefined)).toThrow(/CORS_ORIGIN/);
        expect(() => assertCorsOriginForProduction("production", "")).toThrow(/CORS_ORIGIN/);
        expect(() =>
            assertCorsOriginForProduction("production", "https://app.zknotes.eu"),
        ).not.toThrow();
        expect(() => assertCorsOriginForProduction("development", undefined)).not.toThrow();
        expect(() => assertCorsOriginForProduction("test", undefined)).not.toThrow();
    });
});
