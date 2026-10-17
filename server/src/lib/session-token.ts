import { createHash } from "node:crypto";
import type { FastifyReply } from "fastify";

/**
 * The session token is stored in the database as a SHA-256 hash: the user's cookie carries the raw
 * token, the database only its hash. A DB leak (a backup, SQLi, an insider) therefore yields no
 * directly usable session cookies. One source of truth — used by issueSession, the auth plugin
 * lookup, logout and the session list.
 */
export function hashSessionToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/**
 * The session cookie's name. In production it carries the `__Host-` prefix: a browser then accepts
 * it only with `Secure`, `Path=/` and no `Domain`, so no other host under the same site (a sibling
 * subdomain) can set or shadow it. The prefix needs `Secure`, which local development over plain
 * http cannot have, so development and tests keep the bare name.
 */
export function sessionCookieName(nodeEnv: string | undefined = process.env.NODE_ENV): string {
    return nodeEnv === "production" ? "__Host-session_token" : "session_token";
}

export const SESSION_COOKIE = sessionCookieName();

/**
 * The cookie attributes must match on set and on clear — otherwise the browser can keep a dead
 * cookie. No `domain`: the `__Host-` prefix forbids it.
 */
export const SESSION_COOKIE_BASE = {
    path: "/" as const,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
};

export function clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_BASE);
}
