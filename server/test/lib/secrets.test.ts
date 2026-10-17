import { describe, expect, test } from "bun:test";
import { assertProductionSecret, isUnconfiguredSecret } from "../../src/lib/secrets";

const DEV_DEFAULT = "dev-secret-change-in-prod";

describe("isUnconfiguredSecret", () => {
    test("an unset or blank value is unconfigured", () => {
        expect(isUnconfiguredSecret(undefined, DEV_DEFAULT)).toBe(true);
        expect(isUnconfiguredSecret("", DEV_DEFAULT)).toBe(true);
        expect(isUnconfiguredSecret("   ", DEV_DEFAULT)).toBe(true);
    });

    test("the development default is unconfigured", () => {
        expect(isUnconfiguredSecret(DEV_DEFAULT, DEV_DEFAULT)).toBe(true);
    });

    test("the .env.example placeholders are unconfigured", () => {
        expect(isUnconfiguredSecret("REPLACE_WITH_LONG_RANDOM_STRING", DEV_DEFAULT)).toBe(true);
        expect(isUnconfiguredSecret("REPLACE_WITH_32_BYTE_HEX_STRING", DEV_DEFAULT)).toBe(true);
    });

    test("a real value is configured", () => {
        expect(isUnconfiguredSecret("9f2c4e7a1b3d5f60718293a4b5c6d7e8", DEV_DEFAULT)).toBe(false);
    });
});

describe("assertProductionSecret", () => {
    test("refuses an unconfigured value with the long-standing message", () => {
        expect(() => assertProductionSecret("COOKIE_SECRET", "", DEV_DEFAULT)).toThrow(
            "COOKIE_SECRET must be securely configured in production.",
        );
        expect(() =>
            assertProductionSecret("COOKIE_SECRET", "REPLACE_WITH_LONG_RANDOM_STRING", DEV_DEFAULT),
        ).toThrow("must be securely configured");
    });

    test("refuses a value shorter than 32 characters — a guessable seed is no secret", () => {
        expect(() => assertProductionSecret("KDF_FAKE_SEED", "x", DEV_DEFAULT)).toThrow(
            /at least 32 characters/,
        );
        expect(() => assertProductionSecret("KDF_FAKE_SEED", "a".repeat(31), DEV_DEFAULT)).toThrow(
            /at least 32 characters/,
        );
    });

    test("accepts a 32-character value and the 64 hex characters of `openssl rand -hex 32`", () => {
        expect(() =>
            assertProductionSecret("KDF_FAKE_SEED", "a".repeat(32), DEV_DEFAULT),
        ).not.toThrow();
        expect(() =>
            assertProductionSecret(
                "KDF_FAKE_SEED",
                "9f2c4e7a1b3d5f60718293a4b5c6d7e8".repeat(2),
                DEV_DEFAULT,
            ),
        ).not.toThrow();
    });
});
