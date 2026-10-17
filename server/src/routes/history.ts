import { CreateHistorySnapshotSchema } from "@zknotes/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { uuidv7 } from "uuidv7";
import { db } from "../db";
import { itemHistory } from "../db/schema";
import { parsePositiveIntParam } from "../lib/params";
import { authenticatedLimitEnv, ipRateLimit, userRateLimitPreHandler } from "../lib/rate-limit";
import { nowSec, parseTimestampParam } from "../lib/time";
import { validationErrorPayload } from "../lib/validate";
import { snapshotToWire, wireBlobsToRow } from "../lib/wire";
import { requireUserId } from "../plugins/auth";
import { getNumberedSnapshot, listNumberedSnapshots, thinOut } from "../services/history-service";
import { getOwnedItem, userOwnsLiveItem } from "../services/item-service";
import { getItemStorageSize, updateQuotaTx } from "../services/quota-service";

const historyRoutes: FastifyPluginAsync = async (fastify) => {
    // History (POST thinOut in particular) has to carry an IP rate limit.
    const limits = authenticatedLimitEnv();
    const userMutRl = userRateLimitPreHandler(fastify, limits.mutUserMax, limits.mutWindow);
    const userReadRl = userRateLimitPreHandler(fastify, limits.readUserMax, limits.readWindow);
    const authMut = {
        preParsing: [fastify.authenticateBeforeBody],
        preHandler: [userMutRl],
        config: { rateLimit: ipRateLimit(limits.mutIpMax, limits.mutWindow) },
    };
    const authRead = {
        preParsing: [fastify.authenticateBeforeBody],
        preHandler: [userReadRl],
        config: { rateLimit: ipRateLimit(limits.readIpMax, limits.readWindow) },
    };

    // GET /items/:id/history — the list of a note's snapshots
    fastify.get("/items/:id/history", authRead, async (request, reply) => {
        const userId = requireUserId(request);
        const { id: itemId } = request.params as { id: string };
        const query = request.query as { limit?: string; before?: string };

        // Ownership check
        if (!(await userOwnsLiveItem(itemId, userId))) {
            return reply.status(404).send({ error: "Not found" });
        }

        const limit = parsePositiveIntParam(query.limit, {
            defaultValue: 50,
            min: 0,
            max: 50,
        });
        const beforeSec = parseTimestampParam(query.before);

        const rows = await listNumberedSnapshots(itemId, userId, { limit, beforeSec });
        const snapshots = rows.map(snapshotToWire);

        return reply.send({ snapshots, total: snapshots.length });
    });

    // POST /items/:id/history — creates a new snapshot
    fastify.post("/items/:id/history", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id: itemId } = request.params as { id: string };

        const body = CreateHistorySnapshotSchema.safeParse(request.body);
        if (!body.success) {
            return reply.status(400).send(validationErrorPayload(body.error, "Invalid body"));
        }

        // Check ownership, and that the item is a note (folders and files have no history content)
        const item = await getOwnedItem(db, itemId, userId);
        // A purged row is a tombstone — snapshotting one would recreate the very ciphertext the
        // permanent delete just removed.
        if (!item || item.purged_at != null) return reply.status(404).send({ error: "Not found" });
        // Enforce the type on the server (the client already filters; API abuse would otherwise snapshot a folder or file)
        if (item.type !== "note") {
            return reply.status(400).send({ error: "history_only_for_notes" });
        }

        if (body.data.item_id !== itemId) {
            return reply.status(400).send({ error: "item_id mismatch" });
        }

        const id = uuidv7();
        const blobs = wireBlobsToRow(body.data);
        if (
            !blobs.encrypted_payload ||
            !blobs.payload_nonce ||
            !blobs.encrypted_item_key ||
            !blobs.item_key_nonce
        ) {
            return reply.status(400).send({ error: "Invalid blob data" });
        }

        let insertedResult = null;
        try {
            insertedResult = await db.transaction(async (tx) => {
                const insertSize = getItemStorageSize(blobs as any);

                const [inserted] = await tx
                    .insert(itemHistory)
                    .values({
                        id,
                        item_id: itemId,
                        user_id: userId,
                        encrypted_payload: blobs.encrypted_payload!,
                        payload_nonce: blobs.payload_nonce!,
                        encrypted_item_key: blobs.encrypted_item_key!,
                        item_key_nonce: blobs.item_key_nonce!,
                        item_version_at_snapshot: body.data.item_version_at_snapshot,
                        created_at: nowSec(),
                    })
                    .returning();

                if (!inserted) throw new Error("Insert failed");

                const deletedSize = await thinOut(tx, itemId, userId);

                const dHistory = insertSize - deletedSize;
                await updateQuotaTx(tx, userId, { history: dHistory }, true);

                return inserted;
            });
        } catch (e: unknown) {
            const err = e as Error;
            if (err.name === "QuotaExceededError") {
                return reply.status(413).send({ error: "quota_exceeded" }); // hard_limit_exceeded fallback
            }
            if (err.message === "Insert failed") {
                return reply.status(500).send({ error: "Insert failed" });
            }
            throw e;
        }

        return reply.status(201).send(snapshotToWire(insertedResult));
    });

    // GET /items/:id/history/:snapshotId — fetches one snapshot
    fastify.get("/items/:id/history/:snapshotId", authRead, async (request, reply) => {
        const userId = requireUserId(request);
        const { id: itemId, snapshotId } = request.params as {
            id: string;
            snapshotId: string;
        };

        if (!(await userOwnsLiveItem(itemId, userId))) {
            return reply.status(404).send({ error: "Not found" });
        }

        const row = await getNumberedSnapshot(itemId, userId, snapshotId);

        if (!row) return reply.status(404).send({ error: "Not found" });

        return reply.send(snapshotToWire(row));
    });

    // DELETE /items/:id/history — deletes EVERY snapshot of a note
    fastify.delete("/items/:id/history", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id: itemId } = request.params as { id: string };

        if (!(await userOwnsLiveItem(itemId, userId))) {
            return reply.status(404).send({ error: "Not found" });
        }

        await db.transaction(async (tx) => {
            const deleted = await tx
                .delete(itemHistory)
                .where(and(eq(itemHistory.item_id, itemId), eq(itemHistory.user_id, userId)))
                .returning();

            let deletedSize = 0;
            for (const r of deleted) {
                deletedSize += getItemStorageSize(r);
            }
            if (deletedSize > 0) {
                await updateQuotaTx(tx, userId, { history: -deletedSize }, false);
            }
        });

        return reply.status(204).send();
    });

    // DELETE /items/:id/history/:snapshotId — deleting one snapshot by hand
    fastify.delete("/items/:id/history/:snapshotId", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id: itemId, snapshotId } = request.params as {
            id: string;
            snapshotId: string;
        };

        if (!(await userOwnsLiveItem(itemId, userId))) {
            return reply.status(404).send({ error: "Not found" });
        }

        const deleted = await db.transaction(async (tx) => {
            const [row] = await tx
                .delete(itemHistory)
                .where(
                    and(
                        eq(itemHistory.id, snapshotId),
                        eq(itemHistory.item_id, itemId),
                        eq(itemHistory.user_id, userId),
                    ),
                )
                .returning();

            if (row) {
                const size = getItemStorageSize(row);
                if (size > 0) {
                    await updateQuotaTx(tx, userId, { history: -size }, false);
                }
            }
            return row;
        });

        if (!deleted) return reply.status(404).send({ error: "Not found" });

        return reply.status(204).send();
    });
};

export default historyRoutes;
