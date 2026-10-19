import { isUuid } from "../lib/params";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertKdfParamsFloor, CreateShareSchema, ViewShareSchema } from "@zknotes/shared";
import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { items, shareAttachments, shareLinks, users } from "../db/schema";
import { AUTH_BODY_LIMIT } from "../lib/auth-floor";
import { authenticatedRouteOptions, ipRateLimit } from "../lib/rate-limit";
import { nowSec } from "../lib/time";
import { parseBody } from "../lib/validate";
import { bufToB64, requireB64ToBuf } from "../lib/wire";
import { requireUserId } from "../plugins/auth";
import { S3_BUCKET, s3 } from "../s3";
import { hashAuthKey } from "../services/auth-service";
import {
    floorShareResponse,
    hashViewProof,
    isShareActive,
    SHARE_BURN_DOWNLOAD_GRACE_SEC,
    verifyShareGate,
    viewProofMatches,
} from "../services/share-gate";

const SHARE_CREATE_RL_MAX = Number(process.env.SHARE_CREATE_RATE_LIMIT_MAX ?? 30);
const SHARE_META_RL_MAX = Number(process.env.SHARE_META_RATE_LIMIT_MAX ?? 60);
const SHARE_VIEW_RL_MAX = Number(process.env.SHARE_VIEW_RATE_LIMIT_MAX ?? 10);
const SHARE_CHUNK_RL_MAX = Number(process.env.SHARE_CHUNK_RATE_LIMIT_MAX ?? 120);
const SHARE_RL_WINDOW = process.env.SHARE_RATELIMIT_WINDOW ?? "1 minute";

const UNAVAILABLE = { status: "unavailable" as const };

/** Rejects Postgres cast errors on the public share routes. */
const isShareUuid = isUuid;

type ShareRow = typeof shareLinks.$inferSelect;
type ShareDb = Pick<typeof db, "select" | "update" | "insert">;

/** The owner's wire shape — no user_id and no password material (the hash, salt and params never leave). */
function shareToWire(row: ShareRow) {
    return {
        id: row.id,
        source_item_id: row.source_item_id,
        wrapped_item_key: bufToB64(row.wrapped_item_key),
        item_key_nonce: bufToB64(row.item_key_nonce),
        expires_at: row.expires_at,
        max_views: row.max_views,
        view_count: row.view_count,
        revoked_at: row.revoked_at,
        last_viewed_at: row.last_viewed_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        needs_password: row.share_auth_key_hash != null,
    };
}

async function countActiveShares(tx: ShareDb, userId: string, now: number): Promise<number> {
    const [row] = await tx
        .select({ n: sql<number>`COUNT(*)::integer` })
        .from(shareLinks)
        .where(
            and(
                eq(shareLinks.user_id, userId),
                isNull(shareLinks.revoked_at),
                or(isNull(shareLinks.expires_at), sql`${shareLinks.expires_at} >= ${now}`),
            ),
        );
    return row?.n ?? 0;
}

async function autoRevokeExpiredForItem(tx: ShareDb, sourceItemId: string, now: number) {
    await tx
        .update(shareLinks)
        .set({ revoked_at: now, updated_at: now })
        .where(
            and(
                eq(shareLinks.source_item_id, sourceItemId),
                isNull(shareLinks.revoked_at),
                sql`${shareLinks.expires_at} IS NOT NULL`,
                sql`${shareLinks.expires_at} < ${now}`,
            ),
        );
}

async function loadShareAttachments(tx: ShareDb, shareId: string) {
    return tx
        .select({
            file_id: shareAttachments.file_id,
            wrapped_item_key: shareAttachments.wrapped_item_key,
            item_key_nonce: shareAttachments.item_key_nonce,
            encrypted_payload: items.encrypted_payload,
            payload_nonce: items.payload_nonce,
            chunk_set_id: items.chunk_set_id,
            chunk_count: items.chunk_count,
            deleted_at: items.deleted_at,
        })
        .from(shareAttachments)
        .innerJoin(items, eq(shareAttachments.file_id, items.id))
        .where(eq(shareAttachments.share_id, shareId));
}

function attachmentToWire(
    rows: Awaited<ReturnType<typeof loadShareAttachments>>,
): Array<Record<string, unknown>> {
    return rows
        .filter(
            (r) => r.deleted_at == null && r.encrypted_payload != null && r.payload_nonce != null,
        )
        .map((r) => ({
            file_id: r.file_id,
            wrapped_item_key: bufToB64(r.wrapped_item_key),
            item_key_nonce: bufToB64(r.item_key_nonce),
            encrypted_payload: bufToB64(r.encrypted_payload),
            payload_nonce: bufToB64(r.payload_nonce),
            chunk_set_id: r.chunk_set_id,
            chunk_count: r.chunk_count,
        }));
}

const shareRoutes: FastifyPluginAsync = async (fastify) => {
    const { read: authRead, mut: authMut, userMutRl } = authenticatedRouteOptions(fastify);

    fastify.post(
        "/shares",
        {
            preParsing: [fastify.authenticateBeforeBody],
            preHandler: [userMutRl],
            config: { rateLimit: ipRateLimit(SHARE_CREATE_RL_MAX, SHARE_RL_WINDOW) },
        },
        async (request, reply) => {
            const userId = requireUserId(request);
            const data = parseBody(CreateShareSchema, request, reply);
            if (!data) return;

            const now = nowSec();

            const existing = await db
                .select()
                .from(shareLinks)
                .where(and(eq(shareLinks.id, data.id), eq(shareLinks.user_id, userId)))
                .limit(1);
            if (existing[0]) {
                const atts = await loadShareAttachments(db, data.id);
                return reply.status(200).send({
                    ...shareToWire(existing[0]),
                    attachments: attachmentToWire(atts),
                });
            }

            try {
                const row = await db.transaction(async (tx) => {
                    await autoRevokeExpiredForItem(tx, data.source_item_id, now);

                    // A share is a "shared note" — a folder or file source is not supported in the UI.
                    const [source] = await tx
                        .select({ id: items.id, type: items.type })
                        .from(items)
                        .where(
                            and(
                                eq(items.id, data.source_item_id),
                                eq(items.user_id, userId),
                                isNull(items.deleted_at),
                            ),
                        )
                        .limit(1);
                    if (!source) {
                        return { error: "not_found" as const };
                    }
                    if (source.type !== "note") {
                        return { error: "share_source_must_be_note" as const };
                    }

                    // Seam 2: the core asks "what may this user do", not "which plan is this".
                    const limits = await fastify.entitlements.forUser(tx, userId);
                    const activeCount = await countActiveShares(tx, userId, now);
                    if (activeCount >= limits.maxActiveShares) {
                        return { error: "too_many_shares" as const };
                    }

                    const [activeForItem] = await tx
                        .select({ id: shareLinks.id })
                        .from(shareLinks)
                        .where(
                            and(
                                eq(shareLinks.source_item_id, data.source_item_id),
                                isNull(shareLinks.revoked_at),
                                or(
                                    isNull(shareLinks.expires_at),
                                    sql`${shareLinks.expires_at} >= ${now}`,
                                ),
                            ),
                        )
                        .limit(1);
                    if (activeForItem) {
                        return { error: "share_exists" as const };
                    }

                    if (data.attachments?.length) {
                        for (const att of data.attachments) {
                            const [file] = await tx
                                .select({ id: items.id })
                                .from(items)
                                .where(
                                    and(
                                        eq(items.id, att.file_id),
                                        eq(items.user_id, userId),
                                        eq(items.type, "file"),
                                        eq(items.parent_id, data.source_item_id),
                                        isNull(items.deleted_at),
                                        isNotNull(items.chunk_set_id),
                                    ),
                                )
                                .limit(1);
                            if (!file) return { error: "invalid_attachment" as const };
                        }
                    }

                    let expiresAt: number | null = null;
                    if (data.expires_in_sec != null) {
                        const ttl = Math.min(data.expires_in_sec, limits.maxShareTtlSec);
                        expiresAt = now + ttl;
                    }

                    let shareAuthKeyHash: string | null = null;
                    let shareKdfSalt: Buffer | null = null;
                    let shareKdfParams: string | null = null;

                    if (data.share_auth_key) {
                        assertKdfParamsFloor(data.share_kdf_params!);
                        shareAuthKeyHash = await hashAuthKey(data.share_auth_key);
                        shareKdfSalt = requireB64ToBuf(data.share_kdf_salt!);
                        shareKdfParams = JSON.stringify(data.share_kdf_params);
                    }

                    const viewProofHash = hashViewProof(data.view_proof);

                    try {
                        const [inserted] = await tx
                            .insert(shareLinks)
                            .values({
                                id: data.id,
                                user_id: userId,
                                source_item_id: data.source_item_id,
                                wrapped_item_key: requireB64ToBuf(data.wrapped_item_key),
                                item_key_nonce: requireB64ToBuf(data.item_key_nonce),
                                share_auth_key_hash: shareAuthKeyHash,
                                share_kdf_salt: shareKdfSalt,
                                share_kdf_params: shareKdfParams,
                                view_proof_hash: viewProofHash,
                                expires_at: expiresAt,
                                max_views: data.max_views,
                                created_at: now,
                                updated_at: now,
                            })
                            .returning();

                        if (data.attachments?.length) {
                            await tx.insert(shareAttachments).values(
                                data.attachments.map((att) => ({
                                    share_id: data.id,
                                    file_id: att.file_id,
                                    wrapped_item_key: requireB64ToBuf(att.wrapped_item_key),
                                    item_key_nonce: requireB64ToBuf(att.item_key_nonce),
                                })),
                            );
                        }

                        return { row: inserted! };
                    } catch (e: unknown) {
                        const pgCode = (e as { code?: string })?.code;
                        if (pgCode === "23505") {
                            return { error: "share_exists" as const };
                        }
                        throw e;
                    }
                });

                if ("error" in row) {
                    if (row.error === "not_found")
                        return reply.status(404).send({ error: "not_found" });
                    if (row.error === "share_source_must_be_note")
                        return reply.status(400).send({ error: "share_source_must_be_note" });
                    if (row.error === "invalid_attachment")
                        return reply.status(400).send({ error: "invalid_attachment" });
                    if (row.error === "too_many_shares") {
                        return reply.status(429).send({ error: "too_many_shares" });
                    }
                    if (row.error === "share_exists") {
                        return reply.status(409).send({ error: "share_exists" });
                    }
                }

                const atts = await loadShareAttachments(db, row.row!.id);
                return reply.status(201).send({
                    ...shareToWire(row.row!),
                    attachments: attachmentToWire(atts),
                });
            } catch (e: unknown) {
                if (e instanceof Error && e.message === "weak_kdf_params") {
                    return reply.status(400).send({ error: "weak_kdf_params" });
                }
                throw e;
            }
        },
    );

    fastify.get("/shares", authRead, async (request, reply) => {
        const userId = requireUserId(request);
        const rows = await db
            .select({
                share: shareLinks,
                source_deleted: sql<boolean>`${items.deleted_at} IS NOT NULL`,
                attachment_count: sql<number>`(
                    SELECT COUNT(*)::integer FROM ${shareAttachments}
                    WHERE ${shareAttachments.share_id} = ${shareLinks.id}
                )`,
            })
            .from(shareLinks)
            .leftJoin(items, eq(shareLinks.source_item_id, items.id))
            .where(eq(shareLinks.user_id, userId))
            .orderBy(desc(shareLinks.created_at));

        return reply.send(
            rows.map(({ share, source_deleted, attachment_count }) => ({
                id: share.id,
                source_item_id: share.source_item_id,
                created_at: share.created_at,
                expires_at: share.expires_at,
                revoked_at: share.revoked_at,
                last_viewed_at: share.last_viewed_at,
                view_count: share.view_count,
                max_views: share.max_views,
                needs_password: share.share_auth_key_hash != null,
                source_deleted: Boolean(source_deleted),
                attachment_count,
            })),
        );
    });

    fastify.delete("/shares/:id", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        const now = nowSec();

        const [updated] = await db
            .update(shareLinks)
            .set({
                revoked_at: sql`COALESCE(${shareLinks.revoked_at}, ${now})`,
                // Revoke is the owner's only move once a link has reached the wrong person, so it
                // has to shut the attachment grace window too — including on a link that had
                // already burned, which is exactly the case COALESCE above leaves untouched.
                burn_grace_until: null,
                updated_at: now,
            })
            .where(and(eq(shareLinks.id, id), eq(shareLinks.user_id, userId)))
            .returning();

        if (!updated) return reply.status(404).send({ error: "not_found" });
        return reply.send(shareToWire(updated));
    });

    fastify.get(
        "/shares/:id",
        { config: { rateLimit: ipRateLimit(SHARE_META_RL_MAX, SHARE_RL_WINDOW) } },
        async (request, reply) => {
            reply.header("Cache-Control", "no-store");
            const { id } = request.params as { id: string };
            const started = Date.now();

            // A non-UUID → the same unavailable plus floor as revoked or nonexistent (not a 500 from a Postgres cast).
            if (!isShareUuid(id)) {
                await floorShareResponse(started);
                return reply.send(UNAVAILABLE);
            }

            const gate = await verifyShareGate(db, id, { mode: "meta", started });
            if (!gate.ok) return reply.send(UNAVAILABLE);

            const [attRow] = await db
                .select({
                    attachment_count: sql<number>`COUNT(*)::integer`,
                })
                .from(shareAttachments)
                .where(eq(shareAttachments.share_id, id));

            return reply.send({
                needs_password: gate.share.share_auth_key_hash != null,
                share_kdf_salt: bufToB64(gate.share.share_kdf_salt),
                share_kdf_params: gate.share.share_kdf_params
                    ? JSON.parse(gate.share.share_kdf_params)
                    : undefined,
                expires_at: gate.share.expires_at,
                max_views: gate.share.max_views,
                has_attachments: (attRow?.attachment_count ?? 0) > 0,
            });
        },
    );

    fastify.post(
        "/shares/:id/view",
        {
            // Unauthenticated: without its own limit the route parsed bodies of up to the global
            // 30 MB. The proofs it takes fit in a few hundred bytes.
            bodyLimit: AUTH_BODY_LIMIT,
            config: { rateLimit: ipRateLimit(SHARE_VIEW_RL_MAX, SHARE_RL_WINDOW) },
        },
        async (request, reply) => {
            reply.header("Cache-Control", "no-store");
            const { id } = request.params as { id: string };
            const body = parseBody(ViewShareSchema, request, reply);
            if (!body) return;
            const started = Date.now();

            if (!isShareUuid(id)) {
                await floorShareResponse(started);
                return reply.send(UNAVAILABLE);
            }

            // Argon2 (if any) runs here, outside the burn/view-count transaction, so a slow verify
            // cannot hold FOR UPDATE on the source item. The short transaction below re-reads the
            // share row and re-checks active/proof/deleted/locked so a revoke between the two
            // cannot slip through.
            const [preview] = await db
                .select()
                .from(shareLinks)
                .where(eq(shareLinks.id, id))
                .limit(1);
            if (!preview) {
                await floorShareResponse(started);
                return reply.send(UNAVAILABLE);
            }
            if (!viewProofMatches(preview.view_proof_hash, body.view_proof)) {
                await floorShareResponse(started);
                return reply.send(UNAVAILABLE);
            }
            if (preview.share_auth_key_hash) {
                const gate = await verifyShareGate(db, id, {
                    mode: "view",
                    shareAuthKey: body.share_auth_key,
                    viewProof: body.view_proof,
                    started,
                });
                if (!gate.ok) return reply.send(UNAVAILABLE);
            }

            const result = await db.transaction(async (tx) => {
                const [row] = await tx
                    .select({
                        share: shareLinks,
                        encrypted_payload: items.encrypted_payload,
                        payload_nonce: items.payload_nonce,
                        item_deleted: items.deleted_at,
                        account_locked: users.locked_at,
                    })
                    .from(shareLinks)
                    .innerJoin(items, eq(shareLinks.source_item_id, items.id))
                    .innerJoin(users, eq(shareLinks.user_id, users.id))
                    .where(eq(shareLinks.id, id))
                    .for("update", { of: [shareLinks] })
                    .limit(1);

                if (!row?.share) return { unavailable: true as const };

                const now = nowSec();
                if (
                    !isShareActive(row.share, now) ||
                    row.item_deleted != null ||
                    row.account_locked != null ||
                    row.encrypted_payload == null ||
                    row.payload_nonce == null
                ) {
                    return { unavailable: true as const };
                }

                // Re-check after the lock: the share may have been revoked between the preview
                // verify and this transaction.
                if (!viewProofMatches(row.share.view_proof_hash, body.view_proof)) {
                    return { unavailable: true as const };
                }

                const newViewCount = row.share.view_count + 1;
                const burn = row.share.max_views != null && newViewCount >= row.share.max_views;

                await tx
                    .update(shareLinks)
                    .set({
                        view_count: newViewCount,
                        last_viewed_at: now,
                        revoked_at: burn ? now : row.share.revoked_at,
                        // The attachment grace window is opened HERE and nowhere else, so a revoke
                        // can close it (see DELETE /shares/:id) and neither a revoke nor the expiry
                        // sweep can be mistaken for a burn.
                        burn_grace_until: burn
                            ? now + SHARE_BURN_DOWNLOAD_GRACE_SEC
                            : row.share.burn_grace_until,
                        updated_at: now,
                    })
                    .where(eq(shareLinks.id, id));

                const atts = await loadShareAttachments(tx, id);

                return {
                    unavailable: false as const,
                    encrypted_payload: bufToB64(row.encrypted_payload),
                    payload_nonce: bufToB64(row.payload_nonce),
                    wrapped_item_key: bufToB64(row.share.wrapped_item_key),
                    item_key_nonce: bufToB64(row.share.item_key_nonce),
                    source_item_id: row.share.source_item_id,
                    attachments: attachmentToWire(atts),
                    burned: burn,
                };
            });

            if (result.unavailable) {
                // The same timing floor for EVERY unavailable branch (nonexistent, revoked,
                // expired, deleted source, wrong view_proof) — otherwise the branches can be told
                // apart by measuring.
                await floorShareResponse(started);
                return reply.send(UNAVAILABLE);
            }

            return reply.send({
                encrypted_payload: result.encrypted_payload,
                payload_nonce: result.payload_nonce,
                wrapped_item_key: result.wrapped_item_key,
                item_key_nonce: result.item_key_nonce,
                source_item_id: result.source_item_id,
                attachments: result.attachments,
                // Burn: the recipient may keep downloading attachments for this many more seconds (the UI banner).
                burn_download_grace_sec: result.burned ? SHARE_BURN_DOWNLOAD_GRACE_SEC : undefined,
            });
        },
    );

    fastify.post(
        "/shares/:id/chunks/:fileId/:index",
        {
            bodyLimit: AUTH_BODY_LIMIT,
            config: { rateLimit: ipRateLimit(SHARE_CHUNK_RL_MAX, SHARE_RL_WINDOW) },
        },
        async (request, reply) => {
            const {
                id,
                fileId,
                index: indexParam,
            } = request.params as {
                id: string;
                fileId: string;
                index: string;
            };
            // Both verifiers travel in the JSON body, as for POST /shares/:id/view. A query string ends
            // up in access logs, and so do custom headers — Caddy records every request header except
            // a few credential ones — while a request body does not.
            const body = parseBody(ViewShareSchema, request, reply);
            if (!body) return;
            const shareAuthKey = body.share_auth_key;
            const viewProof = body.view_proof;
            const chunkIndex = Number.parseInt(indexParam, 10);
            if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
                return reply.status(400).send({ error: "invalid_index" });
            }

            const started = Date.now();
            if (!isShareUuid(id) || !isShareUuid(fileId)) {
                await floorShareResponse(started);
                return reply.send(UNAVAILABLE);
            }
            const gate = await verifyShareGate(db, id, {
                mode: "chunk",
                shareAuthKey,
                viewProof,
                started,
            });
            if (!gate.ok) return reply.send(UNAVAILABLE);

            const [att] = await db
                .select({
                    owner_id: shareLinks.user_id,
                    chunk_set_id: items.chunk_set_id,
                    chunk_count: items.chunk_count,
                    deleted_at: items.deleted_at,
                })
                .from(shareAttachments)
                .innerJoin(shareLinks, eq(shareAttachments.share_id, shareLinks.id))
                .innerJoin(items, eq(shareAttachments.file_id, items.id))
                .where(and(eq(shareAttachments.share_id, id), eq(shareAttachments.file_id, fileId)))
                .limit(1);

            if (
                !att?.chunk_set_id ||
                att.deleted_at != null ||
                att.chunk_count == null ||
                chunkIndex >= att.chunk_count
            ) {
                return reply.send(UNAVAILABLE);
            }

            // A short presign: after a revoke, already-issued URLs may live at most this long.
            const command = new GetObjectCommand({
                Bucket: S3_BUCKET,
                Key: `u/${att.owner_id}/${att.chunk_set_id}/${chunkIndex}`,
                ResponseCacheControl: "private, max-age=300",
            });
            const url = await getSignedUrl(s3, command, { expiresIn: 300 });
            reply.header("Cache-Control", "no-store");
            return { url };
        },
    );
};

export default shareRoutes;
