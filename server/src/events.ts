// Seam 4 — the core's events.
//
// The core emits a **fact** and **does not know** who is listening. With no subscriber at all
// everything still works normally — that is the condition for open-core standing on its own.
//
// It is deliberately bound to the Fastify instance rather than to the module: the tests build
// several apps in one process, so a global registry would leak subscribers from one test into the
// next.
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export type UserRegisteredEvent = {
    /** The just-created user. The subscriber decides whether that may be sent anywhere. */
    readonly userId: string;
};

/**
 * The vault's security events. The core only **reports** them; whether a sign-in comes from a "new"
 * device, and whether a mail is sent, is the subscriber's decision, because the known devices and
 * the notification settings live in an extension's tables that open-core must not know about.
 *
 * That is why the type is `login` and not `login_new_device` — no conclusion is drawn here.
 */
type Circumstances = {
    readonly userId: string;
    readonly userAgent: string | null;
    readonly ip: string | null;
};

export type SecurityEvent =
    /** The members are separated by a literal `type` so the union discrimination actually works. */
    | ({ readonly type: "login" } & Circumstances)
    | ({ readonly type: "password_changed" } & Circumstances)
    | { readonly type: "account_locked"; readonly userId: string; readonly reason: string }
    /** The address travels **inside the event**: by the time a subscriber runs, the `users` row is gone. */
    | { readonly type: "account_deleted"; readonly userId: string; readonly email: string };

type Handler = (event: UserRegisteredEvent) => void | Promise<void>;
type SecurityHandler = (event: SecurityEvent) => void | Promise<void>;

declare module "fastify" {
    interface FastifyInstance {
        onUserRegistered(handler: Handler): void;
        emitUserRegistered(event: UserRegisteredEvent): void;
        onSecurityEvent(handler: SecurityHandler): void;
        emitSecurityEvent(event: SecurityEvent): void;
        /**
         * Wait for subscribers that are still in flight.
         *
         * Emitting is deliberately fire-and-forget, so without this every test would have to poll
         * with a timeout — and a test that waits "long enough" is not deterministic, only usually
         * green. It is used on shutdown too, so the last event is not cut off.
         */
        flushSecurityEvents(): Promise<void>;
    }
}

/**
 * Subscribers in flight — **at module level, not per instance.**
 *
 * The registry of *subscribers* deliberately stays per-instance (see the comment above); this is a
 * different thing. `resetDb()` in the tests has no Fastify instance, and its `TRUNCATE` takes an
 * `AccessExclusiveLock`, so it can **deadlock** against a write that is still in flight holding an
 * `AccessShareLock`. That is why waiting has to be available without an instance.
 */
const inFlight = new Set<Promise<void>>();

/** Wait for every in-flight subscriber, whichever instance emitted it. */
export async function flushPendingSecurityEvents(): Promise<void> {
    // A loop rather than a single `Promise.all`: a subscriber is allowed to emit further events.
    while (inFlight.size > 0) await Promise.all([...inFlight]);
}

export const userEvents = fp(
    async (fastify: FastifyInstance) => {
        const handlers: Handler[] = [];
        const securityHandlers: SecurityHandler[] = [];

        fastify.decorate("onUserRegistered", (handler: Handler) => {
            handlers.push(handler);
        });

        fastify.decorate("onSecurityEvent", (handler: SecurityHandler) => {
            securityHandlers.push(handler);
        });

        // Fire-and-forget: a subscriber must not slow down or break registration — a notifier's
        // network round trip does not belong in the response time.
        fastify.decorate("emitUserRegistered", (event: UserRegisteredEvent) => {
            for (const handler of handlers) {
                void Promise.resolve()
                    .then(() => handler(event))
                    .catch((err) => {
                        fastify.log.error({ err }, "onUserRegistered subscriber failed");
                    });
            }
        });

        // The same fire-and-forget reason: a failure to send mail must not break or
        // slow down a sign-in, a password change, or an account deletion.
        fastify.decorate("emitSecurityEvent", (event: SecurityEvent) => {
            for (const handler of securityHandlers) {
                const settled = Promise.resolve()
                    .then(() => handler(event))
                    .catch((err) => {
                        fastify.log.error(
                            { err, type: event.type },
                            "onSecurityEvent subscriber failed",
                        );
                    });
                inFlight.add(settled);
                void settled.finally(() => inFlight.delete(settled));
            }
        });

        fastify.decorate("flushSecurityEvents", flushPendingSecurityEvents);

        // Shutdown waits for mail in flight — otherwise the last event silently disappears.
        fastify.addHook("onClose", async () => {
            await fastify.flushSecurityEvents();
        });
    },
    { name: "user-events" },
);
