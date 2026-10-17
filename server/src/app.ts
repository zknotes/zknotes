import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance, LogController } from "fastify";
import { ipRateLimit, parseTrustProxy } from "./lib/rate-limit";
import { registerClientAddressCheck } from "./lib/client-address-check";
import { assertProductionSecret } from "./lib/secrets";
import { entitlements } from "./entitlements";
import { userEvents } from "./events";
import { buildLoggerOptions, isDev } from "./logger";
import { authenticate } from "./plugins/auth";
import { devLogging } from "./plugins/dev-logging";
import authRoutes from "./routes/auth";
import instanceConfigRoutes from "./routes/instance-config";
import vaultRoutes from "./routes/vault";
import fileRoutes from "./routes/files";
import historyRoutes from "./routes/history";
import itemRoutes from "./routes/items";
import restoreRoutes from "./routes/restore";
import shareRoutes from "./routes/shares";
import { registerAnalyticsHook } from "./services/analytics/hook";
import { type ApiExtension, defaultExtensions } from "./server";

const DEV_COOKIE_SECRET = "dev-cookie-secret-change-in-prod";
const COOKIE_SECRET = process.env.COOKIE_SECRET || DEV_COOKIE_SECRET;

// The bounds for the unauthenticated /client-error (anti log-spam / log-poisoning).
const CLIENT_ERROR_RL_MAX = Number(process.env.CLIENT_ERROR_RATELIMIT_MAX ?? 30);
const CLIENT_ERROR_RL_WINDOW = process.env.CLIENT_ERROR_RATELIMIT_WINDOW ?? "1 minute";
const CLIENT_ERROR_MAX_LEN = Number(process.env.CLIENT_ERROR_MAX_LEN ?? 1000);
// An error message is tiny — an unauthenticated endpoint has no need for the global 30MB bodyLimit.
const CLIENT_ERROR_BODY_LIMIT = Number(process.env.CLIENT_ERROR_BODY_LIMIT ?? 16 * 1024);

if (!isDev) assertProductionSecret("COOKIE_SECRET", process.env.COOKIE_SECRET, DEV_COOKIE_SECRET);

/**
 * A production guard for CORS_ORIGIN — the same hygiene as COOKIE_SECRET / KDF_FAKE_SEED.
 * Without an explicit origin the app would silently allow localhost with credentials:true.
 * Exported as a pure function for the unit test (the module-level import cache does not allow
 * NODE_ENV to be re-evaluated).
 */
export function assertCorsOriginForProduction(
    nodeEnv: string | undefined,
    corsOrigin: string | undefined,
): void {
    if (nodeEnv === "production" && !corsOrigin) {
        throw new Error("CORS_ORIGIN must be configured in production.");
    }
}

assertCorsOriginForProduction(process.env.NODE_ENV, process.env.CORS_ORIGIN);

export async function buildApp(
    opts: { logger?: boolean | object; extensions?: readonly ApiExtension[] } = {},
): Promise<FastifyInstance> {
    // The logger config lives in logger.ts (level from LOG_LEVEL, pretty in dev / JSON+redact in prod).
    const loggerOptions = (opts.logger ?? false) === false ? false : buildLoggerOptions();

    const fastify = Fastify({
        logger: loggerOptions,
        logController: new LogController({ disableRequestLogging: true }),
        // 30 MB, so POST /items and /items/batch can carry a 10 MB payload plus overhead.
        bodyLimit: 30 * 1024 * 1024,
        // `req.ip` comes from X-Forwarded-For ONLY when the peer's own address is listed in
        // TRUST_PROXY (IPs/CIDRs). Unset → nobody is trusted and req.ip is the socket address, so a
        // client that reaches the API directly cannot pick its own address. "true" (trust every
        // peer) and hop counts are refused; see parseTrustProxy.
        trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    });

    // Request logging is tied to the level rather than switched off for good: at the "debug" level
    // (LOG_LEVEL=debug, or a runtime PUT /dev-log-level in development) every request shows up; at
    // info/warn it is silent.
    fastify.addHook("onResponse", (request, reply, done) => {
        request.log.debug(
            {
                method: request.method,
                url: request.url,
                statusCode: reply.statusCode,
                duration_ms: Math.round(reply.elapsedTime),
            },
            "request completed",
        );
        done();
    });

    // In production behind a proxy, say so once if the proxy cannot see visitors' addresses.
    if (process.env.NODE_ENV === "production" && process.env.TRUST_PROXY) {
        registerClientAddressCheck(fastify);
    }

    // Every API response defaults to `no-store`: GET /auth/me carries the wrapped Vault Key, the KDF
    // salt and parameters, and pulls carry the encrypted vault — none of it belongs in the browser's
    // disk cache, where it would outlive a sign-out. A route that sets its own Cache-Control keeps it.
    fastify.addHook("onSend", async (_request, reply, payload) => {
        if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
        return payload;
    });

    await fastify.register(helmet, {
        // The other directives (base-uri, form-action, object-src 'none',
        // upgrade-insecure-requests…) come from helmet's `useDefaults: true` and need not be
        // repeated. The web-app CSP that protects the HTML render lives on the Caddy ingress
        // (docker/Caddyfile), not here — the API returns only JSON.
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", "data:"],
                // The API is never embedded in a <frame>/<iframe> → forbid it explicitly (alongside X-Frame-Options).
                frameAncestors: ["'none'"],
            },
        },
        frameguard: { action: "deny" },
    });

    const allowedOrigins = process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(",")
        : ["http://localhost:5173", "http://localhost:4173"];

    await fastify.register(cors, {
        origin: allowedOrigins,
        credentials: true,
        methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    });

    await fastify.register(rateLimit, { global: false });

    await fastify.register(cookie, {
        secret: COOKIE_SECRET,
        hook: "onRequest",
    });

    fastify.setErrorHandler((error: FastifyError, request, reply) => {
        // 4xx (validation, unauthorized, not found…) are an expected request flow, not a server bug
        // — a full ERROR stack trace is reserved for 5xx and unknown errors. A WARN log with the
        // payload
        // ("API returned a 4xx error response", the app.ts dev hook) is enough for dev visibility.
        const code = error.statusCode;
        if (code !== undefined && code < 500) {
            fastify.log.warn({ err: error }, error.message);
        } else {
            fastify.log.error(error);
        }
        // HEAD responses must carry no body (RFC 7231 §4.3.2) — Bun does not strip it automatically.
        if (request.method === "HEAD") {
            reply.status(code ?? 500).send();
            return;
        }
        // Let Fastify's default handler take validation errors (400) and other expected statuses
        if (code !== undefined) {
            reply.status(code).send(error);
        } else {
            reply.status(500).send({ error: "Internal Server Error" });
        }
    });

    if (isDev) {
        fastify.addHook("onSend", (request, reply, payload, done) => {
            if (reply.statusCode >= 400 && reply.statusCode < 500) {
                let parsedPayload = payload;
                try {
                    if (typeof payload === "string") parsedPayload = JSON.parse(payload);
                } catch {}

                request.log.warn(
                    {
                        method: request.method,
                        url: request.url,
                        statusCode: reply.statusCode,
                        payload: parsedPayload,
                    },
                    "API returned a 4xx error response",
                );
            }
            done(null, payload);
        });
    }

    if (isDev) {
        await fastify.register(devLogging);
    }

    // An endpoint for the frontend to report its own errors (a crypto "invalid tag", say) into the
    // server log. Deliberately present in production too — the client calls it on file-preview
    // errors. It is unauthenticated, hence the IP rate limit (anti log-spam) and the cap on
    // message length, so an attacker cannot inflate the logs with an unbounded payload.
    fastify.post(
        "/client-error",
        {
            bodyLimit: CLIENT_ERROR_BODY_LIMIT,
            config: { rateLimit: ipRateLimit(CLIENT_ERROR_RL_MAX, CLIENT_ERROR_RL_WINDOW) },
        },
        async (request, reply) => {
            const body = request.body as { message?: string };
            const message = String(body?.message ?? "Unknown error").slice(0, CLIENT_ERROR_MAX_LEN);
            fastify.log.error({ client_error: { message } }, `[Frontend Error] ${message}`);
            return reply.send({ success: true });
        },
    );

    await fastify.register(authenticate);
    // Seams 2 and 4 — both before the extensions: one so an extension has something to subscribe
    // to, the other so it may replace the provider before any route answers.
    await fastify.register(entitlements);
    await fastify.register(userEvents);

    // Seam 1 — the extensions get the same instance (the decorators have to stay visible), and they
    // register before the core's own routes, so the core skips a route an extension has claimed
    // (seam 3).
    // `extensions: []` brings up a clean open-core installation.
    for (const extension of opts.extensions ?? defaultExtensions) {
        await extension.register(fastify);
    }

    await fastify.register(authRoutes);
    await fastify.register(instanceConfigRoutes);
    await fastify.register(vaultRoutes);
    await fastify.register(itemRoutes);
    await fastify.register(historyRoutes);
    await fastify.register(fileRoutes);
    await fastify.register(restoreRoutes);
    await fastify.register(shareRoutes);

    registerAnalyticsHook(fastify);

    return fastify;
}
