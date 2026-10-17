// The public health endpoint — no auth, no PII. Used by the Docker healthcheck and by an external
// uptime monitor.
//
// It is reachable by anyone, which is why it carries two guards that an authenticated route does not
// need:
//
//   1. An IP rate limit. Without one, the cheapest way to load an instance is the one endpoint that
//      asks for no credentials at all.
//   2. A short cache of the database probe. Without it, a flood of requests becomes a flood of
//      `SELECT 1` — the endpoint would be a cheaper path to the database than anything behind a
//      login. The window is deliberately far shorter than any sensible monitor interval, so a real
//      outage is still reported on the next poll.
//
// A failed probe is cached exactly like a successful one. That is the point rather than an
// oversight: a database that is already struggling should not also absorb a retry storm, and the
// delay in noticing recovery is bounded by the same short window.
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { ipRateLimit } from "../lib/rate-limit";

/**
 * Read at registration rather than at module load, so a test can lower the ceiling without
 * restarting the process — the same pattern as `maxItemsCount()` in quota-service.
 */
function limits() {
    return {
        max: Number(process.env.HEALTH_RATELIMIT_MAX ?? 60),
        window: process.env.HEALTH_RATELIMIT_WINDOW ?? "1 minute",
    };
}

const DB_CACHE_MS = Number(process.env.HEALTH_DB_CACHE_MS ?? 5000);

/**
 * The release version. The root package.json is the one place it is set — the client build reads it
 * too. A deployment that ships the `server/` package without the root manifest next to it can pass
 * APP_VERSION instead.
 */
export function releaseVersion(): string {
    try {
        const pkg = JSON.parse(
            readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
        );
        if (pkg.name === "zknotes" && typeof pkg.version === "string") return pkg.version;
    } catch {
        // No root manifest in this layout; fall back to the environment.
    }
    return process.env.APP_VERSION || "0.0.0";
}

const VERSION = releaseVersion();

let probe: { at: number; ok: boolean } | null = null;

/** Drops the cached probe. Exported for tests; nothing in production calls it. */
export function resetHealthProbeCache(): void {
    probe = null;
}

/**
 * True when the database answered within the cache window.
 *
 * `now` and `run` are parameters rather than reached for directly so a test can prove the cache
 * instead of restating it: pass a counting `run` and a moving clock, and the number of real probes
 * becomes observable. Production passes neither.
 */
export async function isDatabaseReachable(
    now: number,
    run: () => Promise<unknown> = () => db.execute(sql`SELECT 1`),
): Promise<boolean> {
    if (probe && now - probe.at < DB_CACHE_MS) return probe.ok;
    let ok: boolean;
    try {
        await run();
        ok = true;
    } catch {
        ok = false;
    }
    probe = { at: now, ok };
    return ok;
}

export const health: FastifyPluginAsync = async (fastify) => {
    const { max, window } = limits();
    fastify.get(
        "/health",
        { config: { rateLimit: ipRateLimit(max, window) } },
        async (_request, reply) => {
            if (!(await isDatabaseReachable(Date.now()))) {
                return reply.status(503).send({ status: "error", detail: "db_unreachable" });
            }
            return reply.send({
                status: "ok",
                uptime_seconds: Math.floor(process.uptime()),
                version: VERSION,
                commit: process.env.APP_COMMIT || "dev",
            });
        },
    );
};
