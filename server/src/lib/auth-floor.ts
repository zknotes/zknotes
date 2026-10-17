// The minimum response time of the routes whose timing could tell an account that exists from one
// that does not: /auth/kdf-params, /auth/login, the credential checks behind change-password and
// account deletion, and registration.
//
// It is enforced in `onSend`, which holds the finished response until the floor has passed. Waiting
// inside the handler is not enough: Fastify writes the response the moment `reply.send()` is called,
// so a delay after it only keeps the handler busy while the client already has its answer.
//
// The values are read on every request, so a test can raise the floor for one case while the rest
// of the suite runs at zero.
import type { FastifyReply, FastifyRequest } from "fastify";

/** Production and development keep a small random jitter on top of the floor unless set to 0. */
export const DEFAULT_AUTH_JITTER_MS = 50;

/** The floor without jitter — the share gate's "unavailable" answers use it as it is. */
export function minAuthResponseMs(): number {
    return Number(process.env.MIN_AUTH_RESPONSE_MS ?? 200);
}

function authTargetResponseMs(): number {
    const jitter = Number(process.env.AUTH_JITTER_MS ?? DEFAULT_AUTH_JITTER_MS);
    const floor = minAuthResponseMs();
    return jitter > 0 ? floor + Math.floor(Math.random() * (jitter + 1)) : floor;
}

const startedAt = new WeakMap<FastifyRequest, number>();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Route hooks that give every response of the route — success, wrong password, validation error,
 * Argon2 backlog — the same minimum duration, measured from the moment the request arrived.
 */
export const authResponseFloor = {
    onRequest: async (request: FastifyRequest) => {
        startedAt.set(request, performance.now());
    },
    onSend: async <T>(request: FastifyRequest, _reply: FastifyReply, payload: T): Promise<T> => {
        const started = startedAt.get(request);
        if (started !== undefined) {
            const wait = authTargetResponseMs() - (performance.now() - started);
            // Rounded up: setTimeout drops the fraction of a millisecond and would end just short.
            if (wait > 0) await delay(Math.ceil(wait));
        }
        return payload;
    },
};

/**
 * The body limit of the credential routes. Their largest body (a password change: two auth keys, a
 * salt, KDF parameters and the re-wrapped Vault Key) is well under 1 KiB. Without a limit of their
 * own they would accept the 30 MB the item routes need — on routes anyone can call, or that spend
 * an Argon2 check on every request.
 */
export const AUTH_BODY_LIMIT = 4 * 1024;
