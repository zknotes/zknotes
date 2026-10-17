import type { FastifyInstance } from "fastify";
import { recordRegistration, recordRequest } from "./collector";
import { isAnalyticsEnabled } from "./constants";

/**
 * Registers the server-side analytics hooks — call it after the routes are registered. With
 * analytics disabled nothing is registered, so nothing is recorded, not even in memory.
 */
export function registerAnalyticsHook(fastify: FastifyInstance): void {
    if (!isAnalyticsEnabled()) return;
    fastify.addHook("onResponse", async (request, reply) => {
        try {
            await recordRequest(request, reply);
        } catch {
            // The analytics must not affect the response.
        }
    });
    // A registration is a vault that was really created. Whichever route created it — the
    // core's `POST /vault` or an extension's takeover of it — emits this fact; the branch that answers
    // 201 for an existing address, only so that address cannot be told apart, does not.
    fastify.onUserRegistered(() => recordRegistration());
}
