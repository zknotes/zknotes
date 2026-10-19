import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest, RequestPayload } from "fastify";
import fp from "fastify-plugin";
import { db } from "../db";
import { sessions, users } from "../db/schema";
import {
    clearSessionCookie,
    hashSessionToken,
    SESSION_COOKIE,
    SESSION_COOKIE_BASE,
    SESSION_TTL_SECONDS,
} from "../lib/session-token";
import { nowSec } from "../lib/time";

export function requireUserId(request: { user_id?: string }): string {
    const id = request.user_id;
    if (id === undefined) throw new Error("authenticate middleware not applied");
    return id;
}

function unauthorized(message = "Unauthorized"): Error {
    const err = new Error(message) as Error & { statusCode: number };
    err.statusCode = 401;
    return err;
}

declare module "fastify" {
    interface FastifyRequest {
        user_id?: string;
    }

    interface FastifyInstance {
        authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        /**
         * `authenticate` as a `preParsing` hook — the form every protected route uses. Fastify
         * parses the body before `preValidation`, so authenticating there let anyone without a
         * session make the API parse a body of up to the global limit first. `preParsing` runs
         * after the per-IP rate limit (`onRequest`) and before the body is read.
         */
        authenticateBeforeBody: (
            request: FastifyRequest,
            reply: FastifyReply,
            payload: RequestPayload,
        ) => Promise<RequestPayload>;
    }
}

function accountLocked(): Error {
    const err = new Error("Account locked") as Error & { statusCode: number };
    err.statusCode = 403;
    return err;
}

export const authenticate = fp(async (fastify) => {
    fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
        const token = request.cookies[SESSION_COOKIE];
        if (!token) throw unauthorized();

        // The database stores the token's SHA-256 hash — the incoming cookie is hashed before
        // lookup.
        const tokenHash = hashSessionToken(token);

        // A JOIN with users, so we fetch locked_at (and last_seen_at, for the throttled touch below)
        // in one query instead of two.
        const [row] = await db
            .select({
                user_id: sessions.user_id,
                expires_at: sessions.expires_at,
                locked_at: users.locked_at,
                last_seen_at: users.last_seen_at,
            })
            .from(sessions)
            .innerJoin(users, eq(sessions.user_id, users.id))
            .where(eq(sessions.session_token, tokenHash))
            .limit(1);

        if (!row) throw unauthorized();

        const now = nowSec();

        if (row.expires_at < now) {
            await db.delete(sessions).where(eq(sessions.session_token, tokenHash));
            clearSessionCookie(reply);
            throw unauthorized("Session expired");
        }

        // locked_at is checked AFTER expires_at (we do not extend a locked user's session) but
        // BEFORE the sliding window — there is no point extending a session that does not work anyway.
        if (row.locked_at !== null) throw accountLocked();

        // Extend the session once more than half the TTL has passed (a sliding window).
        const newExpiry = now + SESSION_TTL_SECONDS;
        if (row.expires_at < now + SESSION_TTL_SECONDS / 2) {
            await db
                .update(sessions)
                .set({ expires_at: newExpiry, last_used_at: now })
                .where(eq(sessions.session_token, tokenHash));
            reply.setCookie(SESSION_COOKIE, token, {
                ...SESSION_COOKIE_BASE,
                maxAge: SESSION_TTL_SECONDS,
            });
        }

        // A denormalised last_seen (throttled to ~5 min to avoid a write storm).
        // Fire-and-forget: this is informational/denormalised data, so it must never delay or fail
        // the response — errors are swallowed.
        if (!row.last_seen_at || now - row.last_seen_at >= 300) {
            void db
                .update(users)
                .set({ last_seen_at: now })
                .where(eq(users.id, row.user_id))
                .catch(() => {});
        }

        request.user_id = row.user_id;
    });

    fastify.decorate(
        "authenticateBeforeBody",
        async (request: FastifyRequest, reply: FastifyReply, payload: RequestPayload) => {
            await fastify.authenticate(request, reply);
            return payload;
        },
    );
});
