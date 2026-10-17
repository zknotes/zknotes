// Seam 5 — commercial data in `/instance-config`.
//
// Narrow, typed, and free of vocabulary: the server fills in the values, but **the open code chooses
// where they go and how they look**. If a field is absent, the client does not render that line —
// that is a valid state (a self-host), not an error.
//
// Unauthenticated on purpose: the links to the public site appear on the `login` page too, before
// sign-in. That is why **nothing here is tied to a user** — the plan label is per-user and stays on
// the authenticated `GET /me/storage`.
import type { FastifyPluginAsync } from "fastify";

/** Accepts only `https:` (and `http:` in dev, for `zknotes.localhost`). Anything invalid is omitted. */
function safeUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    try {
        const url = new URL(raw);
        const devHttp = process.env.NODE_ENV !== "production" && url.protocol === "http:";
        return url.protocol === "https:" || devHttp
            ? url.origin + url.pathname.replace(/\/$/, "")
            : undefined;
    } catch {
        return undefined;
    }
}

const instanceConfigRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get("/instance-config", async (_request, reply) => {
        const wwwUrl = safeUrl(process.env.PUBLIC_WWW_URL);
        const manageUrl = safeUrl(process.env.ACCOUNT_MANAGE_URL);
        // AGPL §13 plus the FSF's recommendation for web applications: shipping the client is
        // *conveying*, so the user has to be able to reach the Corresponding Source of what is
        // actually served to them. Runtime, not a build constant, and that is not a formality: an
        // instance that has **modified** the client must point at ITS OWN source, not at ours.
        const sourceUrl = safeUrl(process.env.SOURCE_URL);

        return reply.send({
            // This is **runtime** data. The same build with a different `.env` has to yield
            // the same `manifestHash`, so none of it may enter the client bundle.
            ...(wwwUrl ? { wwwUrl } : {}),
            ...(sourceUrl ? { sourceUrl } : {}),
            ...(manageUrl ? { account: { manageUrl } } : {}),
        });
    });
};

export default instanceConfigRoutes;
