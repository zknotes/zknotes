// Saas spec 156 (package G): validation details never leave a production server.
import { afterEach, describe, expect, test } from "bun:test";
import { validationErrorPayload } from "../../src/lib/validate";

const saved = process.env.NODE_ENV;
afterEach(() => {
    process.env.NODE_ENV = saved;
});

describe("validationErrorPayload", () => {
    test("carries the issues outside production, and only the message in production", () => {
        const error = { issues: [{ path: ["email"], message: "Required" }] };
        process.env.NODE_ENV = "test";
        expect(validationErrorPayload(error)).toEqual({
            error: "Invalid input",
            details: error.issues,
        });
        expect(validationErrorPayload(error, "Bad body").error).toBe("Bad body");
        process.env.NODE_ENV = "production";
        expect(validationErrorPayload(error)).toEqual({ error: "Invalid input" });
    });
});
