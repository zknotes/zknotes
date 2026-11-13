// Proof-of-existence seals. The client hashes the file, builds the manifest and the OpenTimestamps
// tree, and encrypts the result; this route only relays a 32-byte commitment to the instance's
// calendars, keeps the encrypted record, and enforces the daily allowance and the quota.
//
// The commitment and the calendar messages pass through and are never stored or logged.
import {
    CreateSealSchema,
    PutSealSchema,
    type SealListResponse,
    type SealSubmitReply,
    type SealUpgradeReply,
    type SealWire,
    UpgradeSealSchema,
} from "@zknotes/shared";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { chunkSets, seals, users } from "../db/schema";
import { isUuid } from "../lib/params";
import { authenticatedRouteOptions, ipRateLimit } from "../lib/rate-limit";
import { nowSec } from "../lib/time";
import { parseBody } from "../lib/validate";
import { bufToB64, requireB64ToBuf } from "../lib/wire";
import { requireUserId } from "../plugins/auth";
import { calendarUrls, fetchUpgrades, submitCommitment } from "../services/ots-calendar";
import { QuotaExceededError, updateQuotaTx } from "../services/quota-service";
import {
    countSealsInWindow,
    lockUserForSeal,
    sealStorageSize,
    sealsPerDay,
} from "../services/seal-service";

const SEAL_CALENDAR_RL_MAX = Number(process.env.SEAL_CALENDAR_RATE_LIMIT_MAX ?? 30);
const SEAL_RL_WINDOW = process.env.SEAL_RATELIMIT_WINDOW ?? "1 minute";

type SealRow = typeof seals.$inferSelect;

function sealToWire(row: SealRow): SealWire {
    const b64 = (b: Buffer | null) => (b ? bufToB64(b) : null);
    return {
        id: row.id,
        chunk_set_id: row.chunk_set_id,
        state: row.state,
        encrypted_record: b64(row.encrypted_record),
        record_nonce: b64(row.record_nonce),
        encrypted_seal_key: b64(row.encrypted_seal_key),
        seal_key_nonce: b64(row.seal_key_nonce),
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

const sealRoutes: FastifyPluginAsync = async (fastify) => {
    const { read: authRead, mut: authMut, userMutRl } = authenticatedRouteOptions(fastify);
    // The calls that reach the calendars get their own, tighter per-IP limit on top of the user one.
    const calendarRoute = {
        preParsing: [fastify.authenticateBeforeBody],
        preHandler: [userMutRl],
        config: { rateLimit: ipRateLimit(SEAL_CALENDAR_RL_MAX, SEAL_RL_WINDOW) },
    };

    async function ownSeal(id: string, userId: string): Promise<SealRow | undefined> {
        if (!isUuid(id)) return undefined;
        const [row] = await db
            .select()
            .from(seals)
            .where(and(eq(seals.id, id), eq(seals.user_id, userId)))
            .limit(1);
        return row;
    }

    fastify.post("/seals", calendarRoute, async (request, reply) => {
        const userId = requireUserId(request);
        const data = parseBody(CreateSealSchema, request, reply);
        if (!data) return;

        const calendars = calendarUrls();
        if (calendars.length === 0) return reply.status(403).send({ error: "seals_disabled" });
        const limit = sealsPerDay(await fastify.entitlements.forUser(db, userId));
        if (limit === 0) return reply.status(403).send({ error: "seals_disabled" });

        const [existing] = await db
            .select({ id: seals.id })
            .from(seals)
            .where(eq(seals.id, data.id))
            .limit(1);
        if (existing) return reply.status(409).send({ error: "seal_exists" });

        // Someone else's chunk set and a missing one answer the same, so the route reveals nothing.
        const [set] = await db
            .select({ id: chunkSets.id, pending: chunkSets.pending_delete_at })
            .from(chunkSets)
            .where(and(eq(chunkSets.id, data.chunk_set_id), eq(chunkSets.user_id, userId)))
            .limit(1);
        if (!set || set.pending !== null) return reply.status(404).send({ error: "not_found" });

        // A cheap check before the calendars are asked; the authoritative one is under the lock below.
        if ((await countSealsInWindow(db, userId, nowSec())) >= limit) {
            return reply.status(429).send({ error: "seal_limit", limit });
        }

        const replies = await submitCommitment(Buffer.from(data.commitment, "hex"), calendars);
        if (!replies.some((r) => r.ok)) {
            return reply.status(502).send({ error: "calendars_unavailable" });
        }

        const now = nowSec();
        const outcome = await db.transaction(async (tx) => {
            if (!(await lockUserForSeal(tx, userId))) return "not_found" as const;
            if ((await countSealsInWindow(tx, userId, now)) >= limit) return "limit" as const;
            try {
                await tx.insert(seals).values({
                    id: data.id,
                    user_id: userId,
                    chunk_set_id: data.chunk_set_id,
                    state: "pending",
                    created_at: now,
                    updated_at: now,
                });
            } catch (e: unknown) {
                const code = (e as { code?: string })?.code;
                if (code === "23505") return "exists" as const;
                if (code === "23503") return "not_found" as const;
                throw e;
            }
            return "ok" as const;
        });
        if (outcome === "limit") return reply.status(429).send({ error: "seal_limit", limit });
        if (outcome === "exists") return reply.status(409).send({ error: "seal_exists" });
        if (outcome === "not_found") return reply.status(404).send({ error: "not_found" });

        const wire: SealSubmitReply[] = replies.map((r) =>
            r.ok
                ? { calendar: r.calendar, ok: true, body: Buffer.from(r.body).toString("base64") }
                : { calendar: r.calendar, ok: false },
        );
        return reply.status(201).send({ id: data.id, replies: wire });
    });

    fastify.put("/seals/:id", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        if (!isUuid(id)) return reply.status(404).send({ error: "not_found" });
        const data = parseBody(PutSealSchema, request, reply);
        if (!data) return;

        const next = {
            encrypted_record: requireB64ToBuf(data.encrypted_record),
            record_nonce: requireB64ToBuf(data.record_nonce),
            encrypted_seal_key: requireB64ToBuf(data.encrypted_seal_key),
            seal_key_nonce: requireB64ToBuf(data.seal_key_nonce),
        };
        try {
            const result = await db.transaction(async (tx) => {
                const [row] = await tx
                    .select()
                    .from(seals)
                    .where(and(eq(seals.id, id), eq(seals.user_id, userId)))
                    .for("update")
                    .limit(1);
                if (!row) return { error: "not_found" as const };
                // A confirmed proof never goes back to pending.
                if (row.state === "confirmed" && data.state === "pending") {
                    return { error: "seal_state" as const };
                }
                const delta = sealStorageSize(next) - sealStorageSize(row);
                await updateQuotaTx(tx, userId, { items: delta }, delta > 0);
                const [updated] = await tx
                    .update(seals)
                    .set({ ...next, state: data.state, updated_at: nowSec() })
                    .where(eq(seals.id, id))
                    .returning();
                return { row: updated as SealRow };
            });
            if ("error" in result) {
                return reply
                    .status(result.error === "not_found" ? 404 : 409)
                    .send({ error: result.error });
            }
            return reply.send(sealToWire(result.row));
        } catch (e: unknown) {
            if (e instanceof QuotaExceededError) {
                const [user] = await db
                    .select({ used: users.storage_used, quota: users.storage_quota })
                    .from(users)
                    .where(eq(users.id, userId))
                    .limit(1);
                return reply
                    .status(413)
                    .send({ error: "quota_exceeded", used: user?.used, quota: user?.quota });
            }
            throw e;
        }
    });

    fastify.post("/seals/:id/upgrade", calendarRoute, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        if (!(await ownSeal(id, userId))) return reply.status(404).send({ error: "not_found" });
        const data = parseBody(UpgradeSealSchema, request, reply);
        if (!data) return;

        const results = await fetchUpgrades(data.attestations, calendarUrls());
        const wire: SealUpgradeReply[] = results.map((r) =>
            r.status === "confirmed"
                ? { ...r, body: Buffer.from(r.body).toString("base64") }
                : { calendar: r.calendar, message: r.message, status: r.status },
        );
        return reply.send({ results: wire });
    });

    fastify.get("/seals", authRead, async (request, reply) => {
        const userId = requireUserId(request);
        const rows = await db
            .select()
            .from(seals)
            .where(eq(seals.user_id, userId))
            .orderBy(desc(seals.created_at));
        const perDay =
            calendarUrls().length === 0
                ? 0
                : sealsPerDay(await fastify.entitlements.forUser(db, userId));
        const body: SealListResponse = {
            seals: rows.map(sealToWire),
            limit: { per_day: perDay, used_today: await countSealsInWindow(db, userId, nowSec()) },
        };
        return reply.send(body);
    });

    fastify.delete("/seals/:id", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        if (!isUuid(id)) return reply.status(404).send({ error: "not_found" });
        const gone = await db.transaction(async (tx) => {
            const [row] = await tx
                .delete(seals)
                .where(and(eq(seals.id, id), eq(seals.user_id, userId)))
                .returning();
            if (!row) return false;
            const bytes = sealStorageSize(row);
            if (bytes > 0) await updateQuotaTx(tx, userId, { items: -bytes }, false);
            return true;
        });
        if (!gone) return reply.status(404).send({ error: "not_found" });
        return reply.status(204).send();
    });
};

export default sealRoutes;
