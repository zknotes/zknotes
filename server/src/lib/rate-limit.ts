// Shared rate-limit configuration — one source of truth.
// The global @fastify/rate-limit is registered with `global:false` (app.ts), so the outer IP layer
// is switched on per route through `config.rateLimit` (onRequest). The inner per-user layer goes
// through `userRateLimitPreHandler` (preHandler, after authenticate).
//
// The key is `req.ip` (an IPv6 address by its /64, see rateLimitSubject). Fastify derives it from
// `x-forwarded-for` ONLY when the peer's address is listed in `trustProxy` (see parseTrustProxy +
// app.ts). Any other peer gets its socket address, so XFF cannot be spoofed to bypass the limit.
//
// This is IP-based protection (distributional, anti-burst). The per-account lockout is a separate
// mechanism (see `users.failed_attempts`/`locked_until`) and does not belong here.
import { isIPv6 } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import "@fastify/rate-limit";

/**
 * The client IP for the rate-limit key — `req.ip` (trust-proxy aware), never reading XFF by hand.
 */
export const clientIp = (req: Pick<FastifyRequest, "ip">): string => req.ip ?? "unknown";

/**
 * What a per-IP limit counts under. An IPv4 address is its own subject. An IPv6 address counts as
 * its /64: a subscriber is usually handed a whole /64 and could otherwise rotate through it for a
 * fresh quota on every request. An IPv4-mapped address (::ffff:203.0.113.7) counts as its IPv4.
 * Only limit keys use this; sessions and security events keep the full address from `clientIp`.
 */
export function rateLimitSubject(ip: string): string {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped?.[1]) return mapped[1];
    const address = ip.split("%")[0] ?? ip; // a zone id (fe80::1%eth0) is not part of the address
    if (!isIPv6(address)) return ip;
    return `${expandIPv6(address).slice(0, 4).join(":")}::/64`;
}

/** The eight groups of an IPv6 address, lower-case and without leading zeros. */
function expandIPv6(address: string): string[] {
    const [head = "", tail = ""] = address.split("::");
    const toGroups = (part: string): string[] => {
        if (part === "") return [];
        const groups = part.split(":");
        const last = groups[groups.length - 1] ?? "";
        if (last.includes(".")) {
            // An embedded IPv4 tail (64:ff9b::192.0.2.1) fills the last two groups.
            const [a = 0, b = 0, c = 0, d = 0] = last.split(".").map(Number);
            groups.splice(-1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
        }
        return groups;
    };
    const left = toGroups(head);
    const right = address.includes("::") ? toGroups(tail) : [];
    const zeros = Array<string>(8 - left.length - right.length).fill("0");
    return [...left, ...zeros, ...right].map((g) => Number.parseInt(g, 16).toString(16));
}

/** The per-IP limit key for a request: `rateLimitSubject` of the trust-proxy-aware `req.ip`. */
export const rateLimitKey = (req: Pick<FastifyRequest, "ip">): string =>
    rateLimitSubject(clientIp(req));

/** A per-user key, falling back to the IP if the helper is ever applied without `authenticate`. */
export const userOrIpKey = (req: FastifyRequest): string => req.user_id ?? rateLimitKey(req);

export const RATE_LIMIT_EXCEEDED_BODY = {
    statusCode: 429,
    error: "rate_limit_exceeded",
    message: "Too many attempts. Try again later.",
} as const;

/** Skipped in tests, unless `RATE_LIMIT_IN_TEST=1` is deliberately set. */
const skipRateLimitInTest = (): boolean =>
    process.env.NODE_ENV === "test" && process.env.RATE_LIMIT_IN_TEST !== "1";

/** Defaults read from the environment — the numbers live in `.env`, not in the routes. */
export function authenticatedLimitEnv() {
    return {
        mutWindow: process.env.AUTHENTICATED_MUTATION_RATELIMIT_WINDOW ?? "1 minute",
        mutIpMax: Number(process.env.AUTHENTICATED_MUTATION_RATELIMIT_MAX ?? 600),
        mutUserMax: Number(process.env.AUTHENTICATED_MUTATION_USER_RATELIMIT_MAX ?? 600),
        readWindow: process.env.AUTHENTICATED_READ_RATELIMIT_WINDOW ?? "1 minute",
        readIpMax: Number(process.env.AUTHENTICATED_READ_IP_RATELIMIT_MAX ?? 600),
        readUserMax: Number(process.env.AUTHENTICATED_READ_USER_RATELIMIT_MAX ?? 120),
    };
}

/**
 * Parses the `TRUST_PROXY` env into Fastify's `trustProxy` option. It names, by address, the peers
 * whose X-Forwarded-For the API believes:
 *  - unset / empty / `"false"` → `false`: nobody; `req.ip` is the socket address.
 *  - a comma-separated list of IPs and CIDRs → exactly those peers. The shipped
 *    docker/docker-compose.yml sets the subnet of its `edge` network, which only the services that
 *    forward a client address join.
 *  - `"true"` → every peer. Development and tests only: refused in production, because any client
 *    that reaches the port directly could then choose its own address.
 * A hop count (`"1"`) is refused everywhere. Fastify ≥ 5.12.1 ignores it, since a count cannot
 * check who the peer is, so every client would silently share the proxy's address — one rate-limit
 * bucket for everybody.
 */
export function parseTrustProxy(
    v: string | undefined,
    nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean | string {
    const value = v?.trim();
    if (!value || value === "false") return false;
    if (/^\d+$/.test(value)) {
        throw new Error(
            `TRUST_PROXY=${value} is a hop count, which Fastify no longer honours. Set the address or ` +
                "CIDR of the proxy instead (docker/docker-compose.yml uses its edge subnet).",
        );
    }
    // A /0 range trusts every peer exactly as "true" does.
    const everyPeer = value.split(",").some((part) => /\/0$/.test(part.trim()));
    if (value === "true" || everyPeer) {
        if (nodeEnv === "production") {
            throw new Error(
                `TRUST_PROXY=${value} trusts every peer, so any client that reaches the API directly ` +
                    "could choose its own address. Set the address or CIDR of the proxy instead.",
            );
        }
        return value === "true" ? true : value;
    }
    return value;
}

/** Returns a `config.rateLimit` object: `max` requests per `timeWindow` per client IP. */
export function ipRateLimit(max: number, timeWindow: string) {
    return {
        max,
        timeWindow,
        // Skipped in tests — otherwise the IP counter would accumulate across every test request.
        // The `RATE_LIMIT_IN_TEST=1` escape hatch re-activates the limiter for the dedicated
        // rate-limit test; it is read per request (allowList is a function) and has no effect in
        // production.
        allowList: skipRateLimitInTest,
        keyGenerator: rateLimitKey,
        // @fastify/rate-limit `throw`s this builder's return value (index.js:333). The global
        // setErrorHandler (app.ts) reads the status from `error.statusCode` — without it a 429 would
        // come out as a 500. `context.statusCode` is 429 (or 403 for a ban), so we pass it through
        // and the client gets the right code.
        errorResponseBuilder: (_req: FastifyRequest, context: { statusCode?: number }) => ({
            ...RATE_LIMIT_EXCEEDED_BODY,
            statusCode: context.statusCode ?? 429,
        }),
    };
}

type UserRateLimitHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

// The same (fastify, max, window) shares a store — route separation goes into the key (method+url).
const userRlCache = new WeakMap<FastifyInstance, Map<string, UserRateLimitHandler>>();

/**
 * The inner per-user layer. It has to run in `preHandler` (after `authenticate` in
 * `preValidation`). It uses `createRateLimit` — `fastify.rateLimit()` sets `rateLimitRan`, which
 * would make the next layer a silent no-op.
 */
export function userRateLimitPreHandler(
    fastify: FastifyInstance,
    max: number,
    timeWindow: string,
): UserRateLimitHandler {
    let byKey = userRlCache.get(fastify);
    if (!byKey) {
        byKey = new Map();
        userRlCache.set(fastify, byKey);
    }
    const cacheKey = `${max}\0${timeWindow}`;
    const cached = byKey.get(cacheKey);
    if (cached) return cached;

    const check = fastify.createRateLimit({
        max,
        timeWindow,
        allowList: skipRateLimitInTest,
        // LocalStore.child() does not name by route — separation comes only from a separate
        // instance or key. The method is essential: `/items` is both GET and POST.
        keyGenerator: (req) =>
            `${userOrIpKey(req)}|${req.routeOptions.method}|${req.routeOptions.url ?? "?"}`,
    });

    const handler: UserRateLimitHandler = async (req, _reply) => {
        const limit = await check(req);
        // `isAllowed` is true ONLY on the allow list. The normal path has isAllowed=false.
        // 429 strictly on `isExceeded` — otherwise every production request would get a 429.
        // We throw the same object as ipRateLimit's errorResponseBuilder (it `throw`s the builder's
        // result). Fastify treats a `return reply.send()` inside an async preHandler as a payload
        // and sends a second time → ERR_HTTP_HEADERS_SENT.
        if (!limit.isAllowed && limit.isExceeded) {
            throw { ...RATE_LIMIT_EXCEEDED_BODY };
        }
    };
    byKey.set(cacheKey, handler);
    return handler;
}

/** The window of the unauthenticated auth routes' IP limits — read by `auth.ts` and `vault.ts`. */
export function authRateLimitWindow(): string {
    return process.env.AUTH_RATELIMIT_WINDOW ?? "15 minutes";
}

/**
 * The route options every authenticated route uses: authentication before the body is parsed, a
 * per-user limit and a per-IP limit, in a read and a mutation flavour. Six route modules used to
 * build these objects themselves from `authenticatedLimitEnv()`.
 */
export function authenticatedRouteOptions(fastify: FastifyInstance) {
    const limits = authenticatedLimitEnv();
    const userMutRl = userRateLimitPreHandler(fastify, limits.mutUserMax, limits.mutWindow);
    const userReadRl = userRateLimitPreHandler(fastify, limits.readUserMax, limits.readWindow);
    return {
        limits,
        userMutRl,
        userReadRl,
        read: {
            preParsing: [fastify.authenticateBeforeBody],
            preHandler: [userReadRl],
            config: { rateLimit: ipRateLimit(limits.readIpMax, limits.readWindow) },
        },
        mut: {
            preParsing: [fastify.authenticateBeforeBody],
            preHandler: [userMutRl],
            config: { rateLimit: ipRateLimit(limits.mutIpMax, limits.mutWindow) },
        },
    };
}
