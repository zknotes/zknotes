import {
    BatchItemsSchema,
    CreateItemSchema,
    createsCycle,
    decodePullCursor,
    encodePullCursor,
    type PullCursorPayload,
    PullItemsQuerySchema,
    SYNC_LIMITS,
    topoSortByParent,
    UpdateItemSchema,
} from "@zknotes/shared";
import { and, asc, eq, gte, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { chunkSetCommitted } from "../blob-sweeper";
import { db } from "../db";
import { ADVISORY_LOCKS } from "../db/advisory-locks";
import { chunkSets, items, syncDeletedLog } from "../db/schema";
import { authenticatedRouteOptions, ipRateLimit } from "../lib/rate-limit";
import { clampDeletedAt, issuedWatermarkMs, nowSec, parseTimestampParam } from "../lib/time";
import { parseBody } from "../lib/validate";
import { itemToWire, wireBlobsToRow, wireBlobsToRowPartial } from "../lib/wire";
import { requireUserId } from "../plugins/auth";
import {
    bindFileSet,
    buildFolderParentMap,
    countLiveFiles,
    createItemTx,
    fileSetBindable,
    getOwnedItem,
    hasOtherLiveChunkSetRef,
    ItemRejected,
    parentRejection,
    purgeOwnedItem,
    purgeOwnedItemsBatch,
    releaseChunkSetIfUnreferenced,
    trashTransitionDeltas,
} from "../services/item-service";
import {
    beginQuotaAccumulator,
    commitQuotaAccumulator,
    countUserItems,
    getItemStorageSize,
    itemCountExceeded,
    QuotaExceededError,
    type QuotaAccumulator,
    updateQuotaTx,
} from "../services/quota-service";

type ItemRow = typeof items.$inferSelect;

/** The allowance for the JSON envelope `{ items, deleted, server_time, … }` inside PULL_PAGE_BYTES. */
const PULL_ENVELOPE_RESERVE = 1024;
/**
 * The JSON keys, ids, timestamps and numbers of one wire item, generously — added to its blobs'
 * base64 length to bound its size before the row is loaded.
 */
const PULL_ROW_OVERHEAD = 1024;

function jsonUtf8Bytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function takeBounded<T>(
    rows: T[],
    pageSize: number,
    remainingBytes: number,
    sizeOf: (row: T) => number,
): { taken: T[]; hasMore: boolean; bytes: number } {
    const taken: T[] = [];
    let bytes = 0;
    for (const row of rows) {
        const sz = sizeOf(row);
        const overCount = taken.length >= pageSize;
        const overBytes = taken.length > 0 && bytes + sz > remainingBytes;
        if (overCount || overBytes) {
            return { taken, hasMore: true, bytes };
        }
        taken.push(row);
        bytes += sz;
    }
    return { taken, hasMore: false, bytes };
}

interface BatchError {
    id: string;
    error: string;
}

interface BatchConflict {
    id: string;
    current_version: number;
    current_item: ItemRow;
}

/**
 * Thrown inside db.transaction when the locked version re-check (FOR UPDATE, immediately before the
 * UPDATE) finds the version changed since the unlocked check — a concurrent writer got here first.
 * It carries the fresh row so the handler can return a real 409 current_item instead of a stale
 * snapshot.
 */
class ItemVersionConflictError extends Error {
    constructor(public readonly currentItem: ItemRow) {
        super("ITEM_VERSION_CONFLICT");
    }
}

const itemRoutes: FastifyPluginAsync = async (fastify) => {
    const itemsBatchRlWindow = process.env.ITEMS_BATCH_RATELIMIT_WINDOW ?? "1 minute";
    const itemsBatchRlMax = Number(process.env.ITEMS_BATCH_RATE_LIMIT_MAX ?? 600);
    const { read: authRead, mut: authMut, userMutRl } = authenticatedRouteOptions(fastify);

    fastify.get("/items", authRead, async (request, reply) => {
        const userId = requireUserId(request);
        const parsedQuery = PullItemsQuerySchema.safeParse(request.query ?? {});
        if (!parsedQuery.success) {
            return reply.status(400).send({ error: "invalid_input" });
        }
        const query = parsedQuery.data;

        let cursorPayload: PullCursorPayload | null = null;
        if (query.cursor) {
            cursorPayload = decodePullCursor(query.cursor);
            if (!cursorPayload) {
                return reply.status(400).send({ error: "invalid_cursor" });
            }
        }

        const sinceSec = parseTimestampParam(query.since);

        // The order is not arbitrary: the clock BEFORE the query, so the watermark does not
        // overtake the snapshot. The issued value is deliberately reduced by a safety window
        // because `updated_at` is stamped in Node before the commit.
        // With a cursor we echo `st` from the first page — the clock holds for the whole sequence,
        // not per page.
        const server_time = cursorPayload ? cursorPayload.st : issuedWatermarkMs(Date.now());
        const server_time_iso = new Date(server_time).toISOString();

        const pageSize = query.limit;
        let remainingBytes = SYNC_LIMITS.PULL_PAGE_BYTES - PULL_ENVELOPE_RESERVE;

        let idone = cursorPayload?.idone ?? false;
        let ddone = cursorPayload?.ddone ?? false;
        let lastItemTs = cursorPayload?.it;
        let lastItemId = cursorPayload?.iid;
        let lastDelTs = cursorPayload?.dt;
        let lastDelId = cursorPayload?.did;

        const wireItems: ReturnType<typeof itemToWire>[] = [];
        if (!idone) {
            const itemConds: SQL[] = [eq(items.user_id, userId)];
            if (sinceSec) itemConds.push(gte(items.updated_at, sinceSec));
            if (lastItemTs !== undefined && lastItemId) {
                itemConds.push(
                    sql`(${items.updated_at}, ${items.id}) > (${lastItemTs}, ${lastItemId})`,
                );
            }
            // Two steps, so memory is bounded by the byte budget and not only the response: the
            // keyset and an upper bound of each row's wire size first, then the full rows only for
            // the prefix that fits. Loading `limit + 1` full rows up front held up to a thousand
            // payloads of up to ~10 MiB each before the budget cut any of them.
            const metaRows = await db
                .select({
                    id: items.id,
                    updated_at: items.updated_at,
                    wireBytes: sql<number>`(${PULL_ROW_OVERHEAD}
                        + octet_length(${items.sort_order})
                        + 4 * ceil(coalesce(octet_length(${items.encrypted_payload}), 0) / 3.0)
                        + 4 * ceil(coalesce(octet_length(${items.payload_nonce}), 0) / 3.0)
                        + 4 * ceil(coalesce(octet_length(${items.encrypted_item_key}), 0) / 3.0)
                        + 4 * ceil(coalesce(octet_length(${items.item_key_nonce}), 0) / 3.0)
                    )::int8`,
                })
                .from(items)
                .where(and(...itemConds))
                .orderBy(asc(items.updated_at), asc(items.id))
                .limit(pageSize + 1);
            const chosen = takeBounded(metaRows, pageSize, remainingBytes, (m) => m.wireBytes);

            const byId = new Map<string, ItemRow>();
            if (chosen.taken.length > 0) {
                const full = await db
                    .select()
                    .from(items)
                    .where(
                        and(
                            eq(items.user_id, userId),
                            inArray(
                                items.id,
                                chosen.taken.map((m) => m.id),
                            ),
                        ),
                    );
                for (const row of full) byId.set(row.id, row);
            }
            // In the order of the first step. A row deleted in between is simply absent (its
            // deletion reaches the client through sync_deleted_log).
            const pairs = chosen.taken.flatMap((meta) => {
                const row = byId.get(meta.id);
                return row ? [{ meta, wire: itemToWire(row) }] : [];
            });
            // The exact check still applies — a row updated in between may have grown.
            const sized = takeBounded(pairs, pageSize, remainingBytes, (p) =>
                jsonUtf8Bytes(p.wire),
            );
            for (const p of sized.taken) wireItems.push(p.wire);
            remainingBytes -= sized.bytes;
            // The cursor comes from the first step's keyset, not from the reloaded rows: a row
            // updated in between now sorts later and will be sent again, whereas its new
            // `updated_at` as the cursor would skip every row between the two values.
            const lastMeta =
                sized.taken.at(-1)?.meta ?? (pairs.length === 0 ? chosen.taken.at(-1) : undefined);
            if (lastMeta) {
                lastItemTs = lastMeta.updated_at;
                lastItemId = lastMeta.id;
            }
            idone = !chosen.hasMore && !sized.hasMore;
        }

        type DeletedRow = { id: string; deleted_at: number };
        const deletedRows: DeletedRow[] = [];
        if (!ddone && remainingBytes > 0) {
            const delConds: SQL[] = [eq(syncDeletedLog.user_id, userId)];
            if (sinceSec) delConds.push(gte(syncDeletedLog.deleted_at, sinceSec));
            if (lastDelTs !== undefined && lastDelId) {
                delConds.push(
                    sql`(${syncDeletedLog.deleted_at}, ${syncDeletedLog.item_id}) > (${lastDelTs}, ${lastDelId})`,
                );
            }
            const delFetched = await db
                .select({ id: syncDeletedLog.item_id, deleted_at: syncDeletedLog.deleted_at })
                .from(syncDeletedLog)
                .where(and(...delConds))
                .orderBy(asc(syncDeletedLog.deleted_at), asc(syncDeletedLog.item_id))
                .limit(pageSize + 1);
            const sized = takeBounded(delFetched, pageSize, remainingBytes, (row) =>
                jsonUtf8Bytes(row),
            );
            deletedRows.push(...sized.taken);
            if (sized.taken.length > 0) {
                const last = sized.taken[sized.taken.length - 1];
                if (last) {
                    lastDelTs = last.deleted_at;
                    lastDelId = last.id;
                }
            }
            ddone = !sized.hasMore;
        }

        let next_cursor: string | null = null;
        if (!idone || !ddone) {
            next_cursor = encodePullCursor({
                v: 1,
                st: server_time,
                idone,
                ddone,
                ...(idone || lastItemTs === undefined || !lastItemId
                    ? {}
                    : { it: lastItemTs, iid: lastItemId }),
                ...(ddone || lastDelTs === undefined || !lastDelId
                    ? {}
                    : { dt: lastDelTs, did: lastDelId }),
            });
        }

        return reply.send({
            items: wireItems,
            deleted: deletedRows,
            server_time,
            server_time_iso,
            next_cursor,
        });
    });

    fastify.post("/items", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const data = parseBody(CreateItemSchema, request, reply);
        if (!data) return;

        // Idempotency check plus an oracle-safe "id taken" check: fetch the row BY
        // ID WITHOUT the user_id filter so we can tell "exists and is mine" (idempotent 200) from
        // "exists and is SOMEONE ELSE'S" (409 item_id_taken) — without this the insert would fail on
        // a PK violation and leak an uncaught 500 (500 vs 201 was an oracle for the existence of
        // another user's UUID).
        const [existingById] = await db.select().from(items).where(eq(items.id, data.id)).limit(1);
        if (existingById) {
            if (existingById.user_id === userId) {
                return reply.send(itemToWire(existingById));
            }
            return reply.status(409).send({ error: "item_id_taken" });
        }

        // Validate the parent's existence and type as a batch (otherwise a dangling parent_id
        // or a cycle false-negative when the parent is not in the map). buildFolderParentMap knows
        // only folders. A purged or trashed parent (for a READY child) = not found — this prevents
        // orphan files.
        if (data.parent_id !== null) {
            const parent = await getOwnedItem(db, data.parent_id, userId);
            const rejection = parentRejection(parent, data.type, data.deleted_at != null);
            if (rejection) return reply.status(400).send({ error: rejection });
        }

        // Cycle detection check
        if (data.type === "folder" && data.parent_id) {
            const parentMap = await buildFolderParentMap(userId);
            if (createsCycle(data.id, data.parent_id, parentMap)) {
                return reply.status(400).send({ error: "Cycle detected in folder hierarchy" });
            }
        }

        // The preconditions (chunk set committed, the file-count quota) and the insert are shared with the batch create
        // branch through createItemTx.
        const dItems = getItemStorageSize(data);
        try {
            const outcome = await db.transaction(async (tx) => {
                // Item-count ceiling — on creation only, inside the same transaction as the insert
                // so there is no TOCTOU window.
                if (await itemCountExceeded(tx, userId, 1)) {
                    throw new ItemRejected(413, "item_limit_exceeded");
                }
                await updateQuotaTx(tx, userId, { items: dItems }, true);
                const res = await createItemTx(tx, userId, data);
                if (res.kind === "error") throw new ItemRejected(res.status, res.error);
                return res;
            });
            return reply.status(201).send(itemToWire(outcome.row));
        } catch (e: unknown) {
            if (e instanceof QuotaExceededError) {
                return reply.status(413).send({ error: "hard_limit_exceeded" });
            }
            if (e instanceof ItemRejected) return reply.status(e.status).send({ error: e.error });
            throw e;
        }
    });

    fastify.put("/items/:id", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        const data = parseBody(UpdateItemSchema, request, reply);
        if (!data) return;

        const current = await getOwnedItem(db, id, userId);
        if (!current) {
            return reply.status(404).send({ error: "Item not found" });
        }

        // A purged row is a tombstone — an update that would bring the ciphertext back is refused.
        if (current.purged_at) {
            return reply.status(409).send({ error: "Item is permanently deleted" });
        }

        if (current.version !== data.version) {
            return reply
                .status(409)
                .send({ error: "Conflict: version mismatch", current_item: current });
        }

        // A cycle check when the parent changed
        if (data.parent_id !== undefined && data.parent_id !== current.parent_id) {
            // Validate the new parent's existence + type (as in batch / POST).
            // A purged or trashed parent (for a READY child) = not found.
            if (data.parent_id !== null) {
                const parent = await getOwnedItem(db, data.parent_id, userId);
                const rejection = parentRejection(parent, current.type, data.deleted_at != null);
                if (rejection) return reply.status(400).send({ error: rejection });
            }
            const parentMap = await buildFolderParentMap(userId);
            if (createsCycle(id, data.parent_id, parentMap)) {
                return reply.status(400).send({ error: "Cycle detected in folder hierarchy" });
            }
        }

        // Only a file may carry a chunk set. Whether a CHANGED set is committed — or a pending one
        // can be brought back and re-charged — is decided inside the transaction, next to the row lock.
        if (!fileSetBindable(current.type, data.chunk_set_id)) {
            return reply.status(409).send({ error: "Referenced chunk set is not committed" });
        }

        // Trash state does NOT travel through PUT. Soft-delete is `DELETE /items/:id`, synced
        // trash/restore is `POST /items/batch` — both perform the quota transition (files↔trash
        // bucket). PUT is for live edits only, so the quota logic is not duplicated here: a
        // `deleted_at` in the body is allowed only when it does NOT change the trash state (a
        // full-entity PUT of a live item sends `deleted_at: null`), and it is always clamped to
        // server-now so a future date cannot enter the database by this path either (a micro-hole).
        let clampedDeletedAt: number | null | undefined;
        if (data.deleted_at !== undefined) {
            clampedDeletedAt = clampDeletedAt(data.deleted_at);
            const wouldChangeTrashState =
                (current.deleted_at == null) !== (clampedDeletedAt == null);
            if (wouldChangeTrashState) {
                return reply.status(409).send({
                    error: "Trash state must change via DELETE /items/:id or POST /items/batch",
                });
            }
        }

        let dItems = 0;
        const oldPayloadSize = getItemStorageSize(current);
        const mergedData = { ...current, ...data };
        const newPayloadSize = getItemStorageSize(mergedData);
        dItems = newPayloadSize - oldPayloadSize;

        try {
            const updated = await db.transaction(async (tx) => {
                // FOR UPDATE + re-check: `current` was read outside the transaction and may be
                // stale (the request could have waited in a queue). Lock the row and re-check the
                // version immediately before writing — this prevents a TOCTOU lost update when two
                // parallel PUTs pass the outer check with the same (old) version (the second would
                // otherwise blindly overwrite the first, and both would get a 200).
                const locked = await getOwnedItem(tx, id, userId, true);
                if (!locked || locked.purged_at) {
                    throw new Error("Update failed");
                }
                if (locked.version !== data.version) {
                    throw new ItemVersionConflictError(locked);
                }
                if (
                    locked.type === "file" &&
                    data.chunk_set_id &&
                    data.chunk_set_id !== locked.chunk_set_id
                ) {
                    const bound = await bindFileSet(tx, userId, data.chunk_set_id);
                    if (!bound.ok) throw new ItemRejected(bound.status, bound.error);
                }

                // Folder-move TOCTOU (the same pattern as batch): the pre-flight cycle check
                // above runs outside the transaction on a possibly stale snapshot. Two parallel PUTs
                // (or a PUT and a batch), each moving a different folder, can both pass the
                // pre-flight against the same old map and together create a cycle. The same advisory
                // lock key as batch serialises one user's folder mutations; the re-check against a
                // fresh map inside the transaction is the final defence. The comparison is against
                // `locked.parent_id` (fresh, inside the transaction), not the stale `current` —
                // otherwise a concurrent parent change between the outer read and the lock could
                // dodge the re-check.
                if (
                    data.parent_id !== undefined &&
                    data.parent_id !== locked.parent_id &&
                    data.parent_id !== null
                ) {
                    await tx.execute(
                        sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCKS.folderMutation}, hashtext(${userId}))`,
                    );
                    const lockedMap = await buildFolderParentMap(userId, tx);
                    if (createsCycle(id, data.parent_id, lockedMap)) {
                        throw new Error("CYCLE_DETECTED");
                    }
                }

                // A PUT never changes the trash state (checked above), so the size change belongs
                // to the bucket the item is counted in now: trash while it is in the trash.
                await updateQuotaTx(
                    tx,
                    userId,
                    locked.deleted_at != null ? { trash: dItems } : { items: dItems },
                    true,
                );

                const [row] = await tx
                    .update(items)
                    .set({
                        version: locked.version + 1,
                        updated_at: nowSec(),
                        ...(data.parent_id !== undefined ? { parent_id: data.parent_id } : {}),
                        ...(data.sort_order !== undefined ? { sort_order: data.sort_order } : {}),
                        ...(data.chunk_set_id !== undefined
                            ? { chunk_set_id: data.chunk_set_id }
                            : {}),
                        ...(data.chunk_count !== undefined
                            ? { chunk_count: data.chunk_count }
                            : {}),
                        ...(data.ciphertext_size !== undefined
                            ? { ciphertext_size: data.ciphertext_size }
                            : {}),
                        // Only when it was sent and does not change the trash state (the guard above) — clamped.
                        ...(clampedDeletedAt !== undefined ? { deleted_at: clampedDeletedAt } : {}),
                        ...wireBlobsToRowPartial(data),
                    })
                    .where(eq(items.id, id))
                    .returning();
                if (!row) throw new Error("Update failed");

                if (
                    data.chunk_set_id !== undefined &&
                    current.chunk_set_id &&
                    current.chunk_set_id !== data.chunk_set_id
                ) {
                    await releaseChunkSetIfUnreferenced(tx, current.chunk_set_id, userId, id);
                }
                return row;
            });
            return reply.send(itemToWire(updated));
        } catch (e: any) {
            if (e instanceof ItemVersionConflictError) {
                return reply
                    .status(409)
                    .send({ error: "Conflict: version mismatch", current_item: e.currentItem });
            }
            if (e instanceof ItemRejected) return reply.status(e.status).send({ error: e.error });
            if (e instanceof QuotaExceededError) {
                return reply.status(413).send({ error: "hard_limit_exceeded" });
            }
            if (e.message === "CYCLE_DETECTED") {
                return reply.status(400).send({ error: "Cycle detected in folder hierarchy" });
            }
            if (e.message === "Update failed") {
                return reply.status(500).send({ error: "Update failed" });
            }
            throw e;
        }
    });

    fastify.delete("/items/:id", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };

        const current = await getOwnedItem(db, id, userId);
        if (!current) {
            return reply.status(404).send({ error: "Item not found" });
        }

        // Soft-delete → TRASHED (aligned with the batch upsert trash path):
        // - encrypted_* STAY (name and metadata are needed for restore and the cross-device trash UI)
        // - chunk_set_id STAYS (the blob is needed for Restore inside the retention window)
        // - NO markPendingDelete — the blob is kept until hard delete (purge)
        const trashTs = nowSec();

        await db.transaction(async (tx) => {
            // FOR UPDATE + re-check: `current` above was read outside the transaction (only for
            // the 404 UX) and may be stale. Lock the row and re-check its state immediately before
            // writing — this prevents the quota being subtracted twice when two parallel DELETEs hit
            // the same item, and uses the fresh `version` instead of a stale one (otherwise a blind
            // `current.version + 1` can collide with a version written meanwhile by a concurrent
            // PUT).
            const locked = await getOwnedItem(tx, id, userId, true);
            if (!locked || locked.purged_at || locked.deleted_at) {
                // Gone, already purged, or already trashed (another request got here first) — idempotent.
                return;
            }

            const oldPayloadSize = getItemStorageSize(locked);
            let dFiles = 0;
            // The ciphertext is KEPT on trash (see below), so the bytes still
            // exist in the database — they only change bucket (`items` → `trash`), as does a file's
            // blob. `+=` because the blob delta (if this is a file) goes into the same bucket.
            const deltas = await trashTransitionDeltas(
                tx,
                locked,
                userId,
                oldPayloadSize,
                async (chunkSetId) => {
                    const [cs] = await tx
                        .select({ total_size: chunkSets.total_size })
                        .from(chunkSets)
                        .where(eq(chunkSets.id, chunkSetId))
                        .limit(1);
                    return cs ? Number(cs.total_size) : undefined;
                },
            );

            // enforceStrictLimit=false: trashing must never be blocked by the hard limit —
            // otherwise a user over the limit cannot even delete to free up space.
            await updateQuotaTx(tx, userId, deltas, false);

            await tx
                .update(items)
                .set({
                    deleted_at: trashTs,
                    updated_at: trashTs,
                    version: locked.version + 1,
                    // The ciphertext stays (parity with the POST /items/batch trash path)
                })
                .where(eq(items.id, id));
        });

        return reply.send({ success: true });
    });

    // DELETE /items/:id/purge — hard-delete (TRASHED → DELETED)
    // Sets purged_at, nulls every encrypted column, and marks the blob for the async sweeper.
    // Requires the item to be TRASHED (deleted_at IS NOT NULL).
    fastify.delete("/items/:id/purge", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };

        const current = await getOwnedItem(db, id, userId);
        if (!current) {
            return reply.status(404).send({ error: "Item not found" });
        }
        if (!current.deleted_at) {
            return reply.status(409).send({ error: "Item must be trashed before purge" });
        }
        if (current.purged_at) {
            // Idempotent — already purged
            return reply.send({ success: true });
        }

        const nowTs = nowSec();
        await db.transaction(async (tx) => {
            // purgeOwnedItem takes a FOR UPDATE lock and re-checks purged_at inside the
            // transaction — `current` above was read outside it (only for the 404/409 UX) and can be
            // stale if another device started the same purge in parallel (without this: the quota is
            // freed twice and versions collide; see the getOwnedItem doc).
            await purgeOwnedItem(tx, id, userId, nowTs);
        });

        return reply.send({ success: true });
    });

    fastify.post(
        "/items/batch",
        {
            preParsing: [fastify.authenticateBeforeBody],
            preHandler: [userMutRl],
            config: { rateLimit: ipRateLimit(itemsBatchRlMax, itemsBatchRlWindow) },
        },
        async (request, reply) => {
            const userId = requireUserId(request);
            const parsed = parseBody(BatchItemsSchema, request, reply);
            if (!parsed) return;

            const { upsert, delete_ids } = parsed;

            // The pre-flight cycle check (a fast reject without opening a transaction)
            const pendingFolderUpserts = upsert.filter((i) => i.type === "folder");
            if (pendingFolderUpserts.length > 0) {
                const projectedMap = await buildFolderParentMap(userId);
                for (const item of pendingFolderUpserts) {
                    projectedMap.set(item.id, item.parent_id ?? null);
                }
                // The stored folder graph is already acyclic by construction — a NEW cycle can only
                // be introduced through an edge that changed in this request, so only the changed
                // edges need to be walked (the full map is still passed as the lookup for
                // createsCycle to walk internally).
                for (const item of pendingFolderUpserts) {
                    if (createsCycle(item.id, item.parent_id ?? null, projectedMap)) {
                        return reply
                            .status(400)
                            .send({ error: "Cycle detected in folder hierarchy" });
                    }
                }
            }

            const result = await db
                .transaction(async (tx) => {
                    // Folder-move TOCTOU: two parallel batches (X→Y and Y→X) can both pass the
                    // pre-flight against an old snapshot. A per-user advisory lock serialises folder
                    // mutations; then the cycle is re-checked inside the transaction on a fresh map.
                    if (pendingFolderUpserts.length > 0) {
                        await tx.execute(
                            sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCKS.folderMutation}, hashtext(${userId}))`,
                        );
                        const lockedMap = await buildFolderParentMap(userId, tx);
                        for (const item of pendingFolderUpserts) {
                            lockedMap.set(item.id, item.parent_id ?? null);
                        }
                        // Same narrowing as the pre-flight check above — only the edges that
                        // changed in this request can introduce a new cycle.
                        for (const item of pendingFolderUpserts) {
                            if (createsCycle(item.id, item.parent_id ?? null, lockedMap)) {
                                throw new Error("CYCLE_DETECTED");
                            }
                        }
                    }

                    // Fix 1 (batch quota accumulator): the whole handler is already one
                    // transaction, so the `users` row lock is held for its entire duration
                    // regardless. Locking it ONCE here and folding every delta in-memory removes
                    // the redundant per-item SELECT FOR UPDATE + UPDATE round trips (up to 3 per
                    // upsert, up to 3 per delete_ids entry) without changing enforcement — a single
                    // UPDATE flushes the final tallies via commitQuotaAccumulator below.
                    const quotaAcc: QuotaAccumulator = await beginQuotaAccumulator(tx, userId);

                    const succeeded: ItemRow[] = [];
                    const conflicts: BatchConflict[] = [];
                    const errors: BatchError[] = [];

                    // N+1 Fetch chunk sets
                    const neededChunkSetIds = new Set<string>();
                    for (const u of upsert) {
                        if (u.chunk_set_id) neededChunkSetIds.add(u.chunk_set_id);
                    }
                    const chunkSetMap = new Map<string, { total_size: number }>();
                    if (neededChunkSetIds.size > 0) {
                        const chunkSetsRows = await tx
                            .select({ id: chunkSets.id, total_size: chunkSets.total_size })
                            .from(chunkSets)
                            .where(
                                and(
                                    eq(chunkSets.user_id, userId),
                                    inArray(chunkSets.id, Array.from(neededChunkSetIds)),
                                ),
                            );
                        for (const row of chunkSetsRows) {
                            chunkSetMap.set(row.id, { total_size: Number(row.total_size) });
                        }
                    }

                    // fileCountExceeded used to run one COUNT(*) PER NEW file item in
                    // the batch (O(N·M)). Count once, lazily (only if the batch really contains a
                    // new file), and increment locally after each successful file create.
                    let liveFileCount: number | undefined;

                    // The same pattern for the TOTAL item-count ceiling: count once, lazily, then
                    // increment locally — deletes and updates in the batch do not touch this
                    // ceiling, so they still go through when the creates fail (partial success).
                    let liveItemCount: number | undefined;

                    // Prefetch every parent in one SELECT (not N+1 inside the loop).
                    // Peer: the map MUST be updated after every successful create/update in the
                    // batch (in-batch trash/create) — otherwise a READY child under a just-trashed
                    // parent slips through against a stale map.
                    type BatchParentInfo = {
                        type: "note" | "folder" | "file";
                        user_id: string;
                        deleted_at: number | null;
                        purged_at: number | null;
                    };
                    const parentIdsNeeded = [
                        ...new Set(
                            upsert.map((u) => u.parent_id).filter((id): id is string => id != null),
                        ),
                    ];
                    const parentInfoMap = new Map<string, BatchParentInfo>();
                    if (parentIdsNeeded.length > 0) {
                        const parentRows = await tx
                            .select({
                                id: items.id,
                                type: items.type,
                                user_id: items.user_id,
                                deleted_at: items.deleted_at,
                                purged_at: items.purged_at,
                            })
                            .from(items)
                            .where(
                                and(eq(items.user_id, userId), inArray(items.id, parentIdsNeeded)),
                            );
                        for (const row of parentRows) {
                            parentInfoMap.set(row.id, {
                                type: row.type as BatchParentInfo["type"],
                                user_id: row.user_id,
                                deleted_at: row.deleted_at,
                                purged_at: row.purged_at,
                            });
                        }
                    }

                    const rememberParent = (row: {
                        id: string;
                        type: string;
                        user_id: string;
                        deleted_at: number | null;
                        purged_at: number | null;
                    }) => {
                        parentInfoMap.set(row.id, {
                            type: row.type as BatchParentInfo["type"],
                            user_id: row.user_id,
                            deleted_at: row.deleted_at,
                            purged_at: row.purged_at,
                        });
                    };

                    // The same oracle-safe "id taken" guard POST /items has, but
                    // prefetched in ONE query instead of one per item. `getOwnedItem` below filters
                    // by user_id, so an id belonging to somebody else reads as "does not exist" and
                    // the create branch runs — the insert then dies on the primary key, the
                    // transaction rolls back, and the WHOLE batch is lost (a 500) including every
                    // legitimate item beside it. A per-item `item_id_taken` keeps the rest of the
                    // batch alive and matches what the single-item route already returns.
                    const foreignItemIds = new Set<string>();
                    if (upsert.length > 0) {
                        const owners = await tx
                            .select({ id: items.id, user_id: items.user_id })
                            .from(items)
                            .where(
                                inArray(
                                    items.id,
                                    upsert.map((u) => u.id),
                                ),
                            );
                        for (const row of owners) {
                            if (row.user_id !== userId) foreignItemIds.add(row.id);
                        }
                    }

                    // The parent before the child when both are in the batch (avoiding "Parent not
                    // found").
                    for (const itemData of topoSortByParent(upsert, (i) => i.parent_id)) {
                        if (foreignItemIds.has(itemData.id)) {
                            errors.push({ id: itemData.id, error: "item_id_taken" });
                            continue;
                        }

                        if (itemData.parent_id !== null) {
                            const parent = parentInfoMap.get(itemData.parent_id);

                            // A purged parent = not found. A trashed parent is allowed ONLY when
                            // the child also arrives with deleted_at (synced cascade trash,
                            // note→files); a READY child under a trashed parent is an orphan path →
                            // reject.
                            const rejection = parentRejection(
                                parent && parent.user_id === userId ? parent : undefined,
                                itemData.type,
                                itemData.deleted_at != null,
                            );
                            if (rejection) {
                                errors.push({ id: itemData.id, error: rejection });
                                continue;
                            }
                        }

                        // FOR UPDATE: lock the row before checking the version — this prevents a
                        // TOCTOU lost update when two parallel batches modify the same item (see the
                        // getOwnedItem doc).
                        const current = await getOwnedItem(tx, itemData.id, userId, true);

                        const newPayloadSize = getItemStorageSize(itemData);

                        if (!current) {
                            if (liveItemCount === undefined) {
                                liveItemCount = await countUserItems(tx, userId);
                            }
                            if (await itemCountExceeded(tx, userId, 1, liveItemCount)) {
                                errors.push({ id: itemData.id, error: "item_limit_exceeded" });
                                continue;
                            }
                            try {
                                await updateQuotaTx(tx, userId, { items: newPayloadSize }, true, {
                                    accumulator: quotaAcc,
                                });
                            } catch (e: any) {
                                if (e instanceof QuotaExceededError) {
                                    errors.push({ id: itemData.id, error: "hard_limit_exceeded" });
                                    continue;
                                }
                                throw e;
                            }

                            if (itemData.type === "file" && liveFileCount === undefined) {
                                liveFileCount = await countLiveFiles(userId, tx);
                            }
                            const outcome = await createItemTx(tx, userId, itemData, {
                                knownFileCount: liveFileCount,
                                accumulator: quotaAcc,
                            });
                            if (outcome.kind === "error") {
                                // The quota above was already applied (reserved) before the
                                // precondition check in createItemTx — without this it would stay
                                // "taken" with no item behind it (quota drift that accumulates with
                                // every rejected item in the batch).
                                await updateQuotaTx(tx, userId, { items: -newPayloadSize }, false, {
                                    accumulator: quotaAcc,
                                });
                                errors.push({ id: itemData.id, error: outcome.error });
                                continue;
                            }
                            if (itemData.type === "file") liveFileCount = (liveFileCount ?? 0) + 1;
                            liveItemCount += 1;
                            rememberParent(outcome.row);
                            succeeded.push(outcome.row);
                        } else {
                            // Update
                            // A purged row is a tombstone (permanently deleted) — an update
                            // would write the ciphertext back alongside a leftover purged_at. Reject
                            // it rather than resurrecting half an item.
                            if (current.purged_at) {
                                errors.push({
                                    id: itemData.id,
                                    error: "Item is permanently deleted",
                                });
                                continue;
                            }
                            // The type is fixed at creation. The parent rules and the folder cycle
                            // check above went by the type in the request, so a folder sent "as a
                            // note" would skip the cycle check and could be moved under its own
                            // child.
                            if (current.type !== itemData.type) {
                                errors.push({ id: itemData.id, error: "item_type_mismatch" });
                                continue;
                            }
                            if (current.version !== itemData.version) {
                                conflicts.push({
                                    id: itemData.id,
                                    current_version: current.version,
                                    current_item: current,
                                });
                                continue;
                            }

                            if (!fileSetBindable(current.type, itemData.chunk_set_id)) {
                                errors.push({
                                    id: itemData.id,
                                    error: "Referenced chunk set is not committed",
                                });
                                continue;
                            }
                            if (
                                current.type === "file" &&
                                itemData.chunk_set_id &&
                                itemData.chunk_set_id !== current.chunk_set_id
                            ) {
                                const bound = await bindFileSet(tx, userId, itemData.chunk_set_id, {
                                    accumulator: quotaAcc,
                                });
                                if (!bound.ok) {
                                    errors.push({ id: itemData.id, error: bound.error });
                                    continue;
                                }
                            }

                            const oldPayloadSize = getItemStorageSize(current);
                            // Clamp a future deleted_at (clock skew, and anti-abuse against the
                            // retention sweep) — see clampDeletedAt. Past timestamps (offline trash)
                            // are left untouched.
                            const incomingDeletedAt = clampDeletedAt(itemData.deleted_at);
                            const wasTrashed = current.deleted_at !== null;
                            const isTrashed = incomingDeletedAt != null;

                            let dFiles = 0;
                            let dItems = 0;
                            let dTrash = 0;

                            // The payload of a trashed item lives in the `trash`
                            // bucket (the ciphertext is not deleted on soft-delete), so every
                            // transition has to move it too, not just the blob. The bytes are always
                            // in EXACTLY one bucket.
                            if (!wasTrashed && isTrashed) {
                                // READY → TRASHED: payload and blob move into `trash`.
                                const d = await trashTransitionDeltas(
                                    tx,
                                    current,
                                    userId,
                                    oldPayloadSize,
                                    async (chunkSetId) => chunkSetMap.get(chunkSetId)?.total_size,
                                );
                                dItems += d.items;
                                dFiles += d.files;
                                dTrash += d.trash;
                            } else if (wasTrashed && !isTrashed) {
                                // TRASHED → READY: the new payload enters `items`, the old one leaves `trash`.
                                dItems = newPayloadSize;
                                dTrash -= oldPayloadSize;
                                if (
                                    itemData.chunk_set_id &&
                                    !(await hasOtherLiveChunkSetRef(
                                        tx,
                                        itemData.chunk_set_id,
                                        userId,
                                        itemData.id,
                                    ))
                                ) {
                                    const cs = chunkSetMap.get(itemData.chunk_set_id);
                                    if (cs) {
                                        dFiles += cs.total_size;
                                        dTrash -= cs.total_size;
                                    }
                                }
                            } else if (!wasTrashed && !isTrashed) {
                                dItems = newPayloadSize - oldPayloadSize;
                            } else {
                                // TRASHED → TRASHED: the payload changes while the item is in Trash
                                // (an offline edit arriving after the trash). Without this branch the
                                // `trash` counter would drift.
                                dTrash += newPayloadSize - oldPayloadSize;
                            }

                            try {
                                await updateQuotaTx(
                                    tx,
                                    userId,
                                    { files: dFiles, items: dItems, trash: dTrash },
                                    true,
                                    { accumulator: quotaAcc },
                                );
                            } catch (e: any) {
                                if (e instanceof QuotaExceededError) {
                                    errors.push({ id: itemData.id, error: "hard_limit_exceeded" });
                                    continue;
                                }
                                throw e;
                            }

                            const [updated] = await tx
                                .update(items)
                                .set({
                                    parent_id: itemData.parent_id,
                                    sort_order: itemData.sort_order,
                                    ...wireBlobsToRow(itemData),
                                    chunk_set_id: itemData.chunk_set_id ?? null,
                                    chunk_count: itemData.chunk_count ?? null,
                                    ciphertext_size: itemData.ciphertext_size ?? null,
                                    // Synced trash: the client is authoritative for deleted_at
                                    // (trash/restore), so it is persisted for other devices to see
                                    // the trash state. The server clamps a future timestamp
                                    // (clampDeletedAt). purged_at is NOT here — that is server-side
                                    // (hard delete via purge/delete_ids).
                                    deleted_at: incomingDeletedAt,
                                    // Provenance for batch restore: the client
                                    // sends it on trash, and null on restore once deleted_at is gone.
                                    trashed_batch_id: incomingDeletedAt
                                        ? (itemData.trashed_batch_id ?? null)
                                        : null,
                                    version: current.version + 1,
                                    updated_at: nowSec(),
                                })
                                .where(eq(items.id, itemData.id))
                                .returning();
                            if (updated) {
                                rememberParent(updated);
                                succeeded.push(updated);
                            }

                            // A crop swap inside a batch: the refcount guard + the quota (the same as purgeItemTx)
                            if (
                                current.chunk_set_id &&
                                itemData.chunk_set_id &&
                                current.chunk_set_id !== itemData.chunk_set_id
                            ) {
                                await releaseChunkSetIfUnreferenced(
                                    tx,
                                    current.chunk_set_id,
                                    userId,
                                    itemData.id,
                                    { accumulator: quotaAcc },
                                );
                            }
                        }
                    }

                    // Hard delete (DELETED): trash is SYNCED — `deleted_at` arrives through
                    // `upsert`, while `delete_ids` arrives on permanent deletion
                    // (permanentDeleteItem / empty trash). Purge semantics: blob → pending_delete,
                    // quota released, a row in sync_deleted_log. A READY row may be purged directly
                    // here (a supported contract — `purgeItemTx` sets its `deleted_at`); the state
                    // guard lives on the client (`FileLifecycle.can`). The cutoff guard
                    // (`expiredTrashOnly`) applies ONLY to the GC retention sweep.
                    //
                    // Batched (purgeOwnedItemsBatch): the whole handler holds the `users` row lock
                    // for its duration, so the old per-id purge (~8 statements each, sequential)
                    // made an "Empty trash" of a thousand items block every other write of that
                    // user for thousands of round trips. The refused entries are the version-aware
                    // purges the server declined because the item was edited or restored on
                    // another device — the client must know not to delete the row locally
                    // (otherwise it "resurrects" on the next pull). Unknown and already-purged ids
                    // are a silent success, as before.
                    const deleteNow = nowSec();
                    const { refused } = await purgeOwnedItemsBatch(
                        tx,
                        delete_ids.map((entry) =>
                            typeof entry === "string"
                                ? { id: entry }
                                : { id: entry.id, expectedVersion: entry.version },
                        ),
                        userId,
                        deleteNow,
                        { accumulator: quotaAcc },
                    );
                    for (const row of refused) {
                        conflicts.push({
                            id: row.id,
                            current_version: row.version,
                            current_item: row,
                        });
                    }

                    await commitQuotaAccumulator(tx, userId, quotaAcc);

                    return { succeeded, conflicts, errors };
                })
                .catch((e: unknown) => {
                    if (e instanceof Error && e.message === "CYCLE_DETECTED") {
                        return null;
                    }
                    throw e;
                });

            if (result === null) {
                return reply.status(400).send({ error: "Cycle detected in folder hierarchy" });
            }

            return reply.send({
                succeeded: result.succeeded.map(itemToWire),
                conflicts: result.conflicts.map((c) => ({
                    ...c,
                    current_item: itemToWire(c.current_item),
                })),
                errors: result.errors,
            });
        },
    );
};

export default itemRoutes;
