import type { FastifyInstance } from "fastify";

/**
 * Whether an address is private: RFC 1918, CGNAT (100.64/10), loopback, IPv6 unique-local and
 * link-local, and an IPv4 address mapped into IPv6.
 */
export function isPrivateAddress(ip: string): boolean {
    const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/i.exec(ip);
    if (v4) {
        const a = Number(v4[1]);
        const b = Number(v4[2]);
        return (
            a === 10 ||
            a === 127 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127)
        );
    }
    const v6 = ip.toLowerCase();
    return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

/**
 * Watches the first `sample` requests that arrive through the proxy (they carry X-Forwarded-For)
 * and warns once if every one of them came from the same private address. That is what the API sees
 * when the proxy itself cannot see visitors' addresses — rootless Docker's default port forwarding,
 * or IPv6 clients of an IPv4-only Docker network — and then every per-address limit, the sign-in
 * pause included, is one bucket for everybody. Nothing is blocked; it only says so in the log.
 */
export function registerClientAddressCheck(
    fastify: FastifyInstance,
    opts: { sample?: number; warn?: (message: string) => void } = {},
): void {
    const sample = opts.sample ?? 50;
    const warn = opts.warn ?? ((message: string) => fastify.log.warn(message));
    let first: string | null = null;
    let seen = 0;
    let settled = false;

    fastify.addHook("onRequest", async (request) => {
        if (settled || request.headers["x-forwarded-for"] === undefined) return;
        if (first === null) first = request.ip;
        else if (request.ip !== first) {
            settled = true;
            return;
        }
        seen += 1;
        if (seen < sample) return;
        settled = true;
        if (isPrivateAddress(first)) {
            warn(
                `Every one of the first ${sample} proxied requests came from ${first}, a private ` +
                    "address: the reverse proxy cannot see visitors' own addresses, so every " +
                    "per-address limit — the sign-in pause included — is shared by all of them. " +
                    "Rootless Docker does this by default; docker/setup.sh offers the fix, and " +
                    'docker/README.md ("Security checklist") explains it. If this instance is only ' +
                    "reachable from a private network, ignore this.",
            );
        }
    });
}
