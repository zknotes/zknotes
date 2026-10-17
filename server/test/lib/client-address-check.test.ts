import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { isPrivateAddress, registerClientAddressCheck } from "../../src/lib/client-address-check";

describe("isPrivateAddress", () => {
    test("private, loopback, CGNAT and local IPv6 ranges", () => {
        for (const ip of [
            "10.0.2.100",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.5",
            "100.64.0.1",
            "127.0.0.1",
            "::ffff:10.0.2.100",
            "::1",
            "fd00::1",
            "fe80::1",
        ]) {
            expect(isPrivateAddress(ip), ip).toBe(true);
        }
    });

    test("public addresses", () => {
        for (const ip of ["203.0.113.7", "172.32.0.1", "100.128.0.1", "2001:db8::1", "8.8.8.8"]) {
            expect(isPrivateAddress(ip), ip).toBe(false);
        }
    });
});

async function appWithCheck(warnings: string[]) {
    const app = Fastify({ trustProxy: "127.0.0.1" });
    registerClientAddressCheck(app, { sample: 5, warn: (m) => warnings.push(m) });
    app.get("/x", async () => ({ ok: true }));
    await app.ready();
    return app;
}

const through = (xff: string) => ({
    method: "GET" as const,
    url: "/x",
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-for": xff },
});

describe("registerClientAddressCheck", () => {
    test("warns once when every proxied client is the same private address", async () => {
        const warnings: string[] = [];
        const app = await appWithCheck(warnings);
        for (let i = 0; i < 12; i++) await app.inject(through("10.0.2.100"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("10.0.2.100");
        await app.close();
    });

    test("stays quiet for distinct clients, a single public client, and unproxied requests", async () => {
        const warnings: string[] = [];
        const distinct = await appWithCheck(warnings);
        for (let i = 0; i < 12; i++) await distinct.inject(through(`203.0.113.${i + 1}`));
        await distinct.close();

        const single = await appWithCheck(warnings);
        for (let i = 0; i < 12; i++) await single.inject(through("203.0.113.7"));
        await single.close();

        const direct = await appWithCheck(warnings);
        for (let i = 0; i < 12; i++) await direct.inject({ method: "GET", url: "/x" });
        await direct.close();

        expect(warnings).toEqual([]);
    });
});
