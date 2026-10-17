import { describe, expect, test } from "bun:test";
import type { FastifyRequest } from "fastify";
import {
    clientIp,
    parseTrustProxy,
    rateLimitKey,
    rateLimitSubject,
} from "../../src/lib/rate-limit";

describe("clientIp", () => {
    test("it uses req.ip and ignores a spoofed X-Forwarded-For", () => {
        // Before the fix: it read XFF[0] ('1.2.3.4'), so every spoofed IP got its own bucket.
        const req = {
            ip: "10.0.0.1",
            headers: { "x-forwarded-for": "1.2.3.4" },
        } as unknown as FastifyRequest;
        expect(clientIp(req)).toBe("10.0.0.1");
    });

    test("falls back to 'unknown' when there is no ip", () => {
        expect(clientIp({ ip: undefined } as unknown as FastifyRequest)).toBe("unknown");
    });

    test("keeps the full IPv6 address (sessions and security events record it)", () => {
        const req = { ip: "2001:db8:1:2:3:4:5:6" } as unknown as FastifyRequest;
        expect(clientIp(req)).toBe("2001:db8:1:2:3:4:5:6");
    });
});

describe("rateLimitSubject", () => {
    test("an IPv4 address is its own subject", () => {
        expect(rateLimitSubject("203.0.113.7")).toBe("203.0.113.7");
    });

    test("an IPv4-mapped IPv6 address counts as the IPv4 address", () => {
        expect(rateLimitSubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
        expect(rateLimitSubject("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    });

    test("every address in one IPv6 /64 shares a subject", () => {
        const a = rateLimitSubject("2001:db8:1:2:aaaa::1");
        const b = rateLimitSubject("2001:db8:1:2:ffff:ffff:ffff:fffe");
        expect(a).toBe("2001:db8:1:2::/64");
        expect(b).toBe(a);
    });

    test("different /64s are different subjects", () => {
        expect(rateLimitSubject("2001:db8:1:2::1")).not.toBe(rateLimitSubject("2001:db8:1:3::1"));
    });

    test("spelling does not matter: compressed, padded, upper case and zone id agree", () => {
        const canonical = "2001:db8:0:0::/64";
        expect(rateLimitSubject("2001:db8::1")).toBe(canonical);
        expect(rateLimitSubject("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe(canonical);
        expect(rateLimitSubject("2001:db8::1%eth0")).toBe(canonical);
        expect(rateLimitSubject("::1")).toBe("0:0:0:0::/64");
    });

    test("an IPv6 address with an embedded IPv4 tail still keys on its /64", () => {
        expect(rateLimitSubject("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    });

    test("anything that is not an IP address passes through unchanged", () => {
        expect(rateLimitSubject("unknown")).toBe("unknown");
    });

    test("rateLimitKey applies it to req.ip", () => {
        const req = { ip: "2001:db8:1:2::42" } as unknown as FastifyRequest;
        expect(rateLimitKey(req)).toBe("2001:db8:1:2::/64");
    });
});

describe("parseTrustProxy", () => {
    test("unset / empty / 'false' → false (the safe default)", () => {
        expect(parseTrustProxy(undefined)).toBe(false);
        expect(parseTrustProxy("")).toBe(false);
        expect(parseTrustProxy("  ")).toBe(false);
        expect(parseTrustProxy("false")).toBe(false);
    });

    test("a CIDR/IP list → a string (passed through to Fastify trustProxy)", () => {
        expect(parseTrustProxy("10.0.0.0/8,172.16.0.1")).toBe("10.0.0.0/8,172.16.0.1");
        expect(parseTrustProxy(" 172.30.250.0/24 ")).toBe("172.30.250.0/24");
    });

    test("a hop count is refused: Fastify ignores it, so every client would share one address", () => {
        expect(() => parseTrustProxy("1")).toThrow(/hop count/);
        expect(() => parseTrustProxy(" 2 ")).toThrow(/hop count/);
    });

    test("'true' trusts every peer — allowed outside production, refused in production", () => {
        expect(parseTrustProxy("true", "development")).toBe(true);
        expect(parseTrustProxy("true", "test")).toBe(true);
        expect(() => parseTrustProxy("true", "production")).toThrow(/every peer/);
    });

    test("a /0 range is 'true' by another name — refused in production too", () => {
        for (const v of ["0.0.0.0/0", "::/0", "172.30.250.0/24, 0.0.0.0/0"]) {
            expect(() => parseTrustProxy(v, "production")).toThrow(/every peer/);
            expect(parseTrustProxy(v, "development")).toBe(v);
        }
    });
});
