import { describe, expect, test } from "bun:test";
import {
    hashSessionToken,
    SESSION_COOKIE_BASE,
    sessionCookieName,
} from "../../src/lib/session-token";

describe("hashSessionToken", () => {
    test("returns deterministic sha256 hex digest", () => {
        const token = "session-token-abc";
        expect(hashSessionToken(token)).toBe(
            "bb7bc9c17f37dfedb0a4b3b7e53d6dff8688c54ca6ae8a3ef5d2e0884de7248a",
        );
        expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    });

    test("different tokens produce different hashes", () => {
        expect(hashSessionToken("one")).not.toBe(hashSessionToken("two"));
    });
});

describe("the session cookie", () => {
    // A sibling subdomain could set or shadow a bare `session_token` for this site; the `__Host-`
    // prefix makes the browser refuse any such cookie.
    test("is __Host- prefixed in production, and bare where there is no https", () => {
        expect(sessionCookieName("production")).toBe("__Host-session_token");
        expect(sessionCookieName("development")).toBe("session_token");
        expect(sessionCookieName("test")).toBe("session_token");
    });

    test("has the attributes the prefix requires: Path=/ and no Domain", () => {
        expect(SESSION_COOKIE_BASE.path).toBe("/");
        expect("domain" in SESSION_COOKIE_BASE).toBe(false);
    });
});
