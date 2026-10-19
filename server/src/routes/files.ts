import { isUuid } from "../lib/params";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
    FILE_LIMITS,
    MintUploadUrlsSchema,
    OpenUploadSchema,
    RESTORE_LIMITS,
} from "@zknotes/shared";
import { and, count, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { uuidv7 } from "uuidv7";
import { db } from "../db";
import { chunkSets, fileChunks, items, restoreSessions, uploadSessions, users } from "../db/schema";
import { authenticatedRouteOptions, ipRateLimit } from "../lib/rate-limit";
import { nowSec } from "../lib/time";
import { parseBody } from "../lib/validate";
import { requireUserId } from "../plugins/auth";
import { S3_BUCKET, s3 } from "../s3";
import { countUserItems, QuotaExceededError, updateQuotaTx } from "../services/quota-service";
import {
    deleteS3Prefix,
    listUploadChunkObjects,
    userOwnsChunkSetOrUpload,
} from "../services/storage-service";

async function abortTxn(chunkSetId: string, userId: string): Promise<{ code: 200 | 404 | 409 }> {
    return db.transaction(async (tx) => {
        const [session] = await tx
            .select({ status: uploadSessions.status, total_size: uploadSessions.total_size })
            .from(uploadSessions)
            .where(and(eq(uploadSessions.id, chunkSetId), eq(uploadSessions.user_id, userId)))
            .for("update")
            .limit(1);
        if (!session) return { code: 404 };
        if (session.status === "committed") return { code: 409 };
        // Idempotent: a repeated DELETE must not release the reserved quota a second time.
        if (session.status === "aborted") return { code: 200 };

        await updateQuotaTx(tx, userId, { files: -session.total_size }, false);

        await tx.delete(fileChunks).where(eq(fileChunks.chunk_set_id, chunkSetId));
        await tx
            .update(uploadSessions)
            .set({ status: "aborted", updated_at: nowSec() })
            .where(eq(uploadSessions.id, chunkSetId));

        return { code: 200 };
    });
}

function parseChunkParams(
    request: FastifyRequest,
):
    | { ok: true; chunkSetId: string; chunkIndex: number }
    | { ok: false; error: "bad_chunk_set_id" | "bad_chunk_index" } {
    const { chunkSetId, index } = request.params as { chunkSetId: string; index: string };
    if (!isUuid(chunkSetId)) return { ok: false, error: "bad_chunk_set_id" };
    const chunkIndex = Number(index);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0)
        return { ok: false, error: "bad_chunk_index" };
    return { ok: true, chunkSetId, chunkIndex };
}

const fileRoutes: FastifyPluginAsync = async (fastify) => {
    const uploadRlWindow = process.env.UPLOAD_RATELIMIT_WINDOW ?? "1 minute";
    const uploadOpenRlMax = Number(process.env.UPLOAD_OPEN_RATE_LIMIT_MAX ?? 60);
    const uploadChunkRlMax = Number(process.env.UPLOAD_CHUNK_RATE_LIMIT_MAX ?? 10_000);

    fastify.addContentTypeParser(
        "application/octet-stream",
        { parseAs: "buffer" },
        (_req, body, done) => done(null, body),
    );

    const {
        mut: authMut,
        userMutRl,
        userReadRl,
        limits: rlEnv,
    } = authenticatedRouteOptions(fastify);
    const authOpenRl = {
        preParsing: [fastify.authenticateBeforeBody],
        preHandler: [userMutRl],
        config: { rateLimit: ipRateLimit(uploadOpenRlMax, uploadRlWindow) },
    };
    const authChunkRl = {
        preParsing: [fastify.authenticateBeforeBody],
        config: { rateLimit: ipRateLimit(uploadChunkRlMax, uploadRlWindow) },
    };
    const authChunkMutRl = {
        preParsing: [fastify.authenticateBeforeBody],
        preHandler: [userMutRl],
        config: { rateLimit: ipRateLimit(uploadChunkRlMax, uploadRlWindow) },
    };

    // POST /uploads — opens a session
    fastify.post("/uploads", authOpenRl, async (request, reply) => {
        const userId = requireUserId(request);
        const data = parseBody(OpenUploadSchema, request, reply);
        if (!data) return;
        const { expected_chunks, total_size, chunk_sizes, restore_session_id } = data;

        // debug, not info: at info this was a per-user activity trail in the production log.
        request.log.debug(
            `[upload] User ${userId} starting upload of ${expected_chunks} chunks (${total_size} bytes)`,
        );

        // The per-user file size limit (users.max_file_size — "you get what you pay for").
        // The Zod schema above checks only the absolute MAX_FILE_SIZE_CAP; the real plan is here.
        // total_size is ciphertext (plaintext plus an AEAD tag per chunk), so raise the limit by the
        // tags.
        const [limits] = await db
            .select({ max_file_size: users.max_file_size })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        if (!limits) return reply.status(401).send({ error: "Unauthorized" });
        if (total_size > limits.max_file_size + expected_chunks * FILE_LIMITS.AEAD_TAG) {
            return reply
                .status(413)
                .send({ error: "file_too_large", max_file_size: limits.max_file_size });
        }

        // Restore staging: it does not count towards the cap of 5 (`status = uploading`); instead
        // one open restore session plus MAX_PARALLEL_STAGING_UPLOADS inside it.
        if (restore_session_id) {
            const [rs] = await db
                .select({
                    id: restoreSessions.id,
                    status: restoreSessions.status,
                    expires_at: restoreSessions.expires_at,
                })
                .from(restoreSessions)
                .where(
                    and(
                        eq(restoreSessions.id, restore_session_id),
                        eq(restoreSessions.user_id, userId),
                    ),
                )
                .limit(1);
            if (!rs) return reply.status(404).send({ error: "restore_session_not_found" });
            if (rs.status !== "open") {
                return reply.status(409).send({ error: "restore_session_not_open" });
            }
            if (rs.expires_at < nowSec()) {
                return reply.status(410).send({ error: "restore_session_expired" });
            }
            const [openRestore] = await db
                .select({ n: count() })
                .from(uploadSessions)
                .where(
                    and(
                        eq(uploadSessions.restore_session_id, restore_session_id),
                        eq(uploadSessions.status, "restore_staging"),
                    ),
                );
            if (Number(openRestore?.n ?? 0) >= RESTORE_LIMITS.MAX_PARALLEL_STAGING_UPLOADS) {
                return reply.status(429).send({ error: "too_many_restore_uploads" });
            }
        } else {
            // Anti-abuse: a limit on the uploads in flight at once
            const [open] = await db
                .select({ n: count() })
                .from(uploadSessions)
                .where(
                    and(eq(uploadSessions.user_id, userId), eq(uploadSessions.status, "uploading")),
                );
            if (Number(open?.n ?? 0) >= FILE_LIMITS.MAX_CONCURRENT_UPLOAD_SESSIONS) {
                return reply.status(429).send({ error: "too_many_uploads" });
            }
        }

        const chunkSetId = uuidv7();
        const uploadStatus = restore_session_id ? "restore_staging" : "uploading";
        const quotaOpts = restore_session_id
            ? { peakFactor: RESTORE_LIMITS.PEAK_FACTOR }
            : undefined;

        try {
            await db.transaction(async (tx) => {
                // Atomic quota update: reserve the total size up front
                await updateQuotaTx(tx, userId, { files: total_size }, true, quotaOpts);

                await tx.insert(uploadSessions).values({
                    id: chunkSetId,
                    user_id: userId,
                    expected_chunks,
                    total_size,
                    chunk_sizes,
                    status: uploadStatus,
                    restore_session_id: restore_session_id ?? null,
                });
            });
        } catch (e: any) {
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

        // The presigned URLs are minted lazily through POST /uploads/:id/urls.
        return reply.status(201).send({ chunk_set_id: chunkSetId });
    });

    // POST /uploads/:chunkSetId/urls — lazy mint of presigned PUT URLs
    fastify.post("/uploads/:chunkSetId/urls", authChunkMutRl, async (request, reply) => {
        const userId = requireUserId(request);
        const { chunkSetId } = request.params as { chunkSetId: string };
        if (!isUuid(chunkSetId)) return reply.status(400).send({ error: "bad_chunk_set_id" });

        const data = parseBody(MintUploadUrlsSchema, request, reply);
        if (!data) return;

        const uniqueIndices = [...new Set(data.indices)];
        if (uniqueIndices.length !== data.indices.length) {
            return reply.status(400).send({ error: "duplicate_indices" });
        }

        const [session] = await db
            .select({
                status: uploadSessions.status,
                expected_chunks: uploadSessions.expected_chunks,
                chunk_sizes: uploadSessions.chunk_sizes,
            })
            .from(uploadSessions)
            .where(and(eq(uploadSessions.id, chunkSetId), eq(uploadSessions.user_id, userId)))
            .limit(1);

        if (!session) return reply.status(404).send({ error: "no_session" });
        if (session.status !== "uploading" && session.status !== "restore_staging") {
            return reply.status(409).send({ error: "session_not_uploading" });
        }

        const storedSizes = session.chunk_sizes;
        if (!storedSizes || storedSizes.length !== session.expected_chunks) {
            return reply.status(500).send({ error: "invalid_session_chunk_sizes" });
        }

        for (const idx of uniqueIndices) {
            if (idx < 0 || idx >= session.expected_chunks) {
                return reply.status(400).send({ error: "bad_chunk_index", index: idx });
            }
        }

        const urls: { index: number; put_url: string }[] = [];
        for (const idx of uniqueIndices) {
            const command = new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: `u/${userId}/${chunkSetId}/${idx}`,
                ContentLength: storedSizes[idx],
            });
            const put_url = await getSignedUrl(s3, command, {
                expiresIn: FILE_LIMITS.PRESIGNED_PUT_EXPIRES_SEC,
            });
            urls.push({ index: idx, put_url });
        }

        await db
            .update(uploadSessions)
            .set({ updated_at: nowSec() })
            .where(eq(uploadSessions.id, chunkSetId));

        return reply.send({ urls });
    });

    // POST /uploads/:chunkSetId/ping — a heartbeat against the GC of stale sessions
    fastify.post("/uploads/:chunkSetId/ping", authChunkMutRl, async (request, reply) => {
        const userId = requireUserId(request);
        const { chunkSetId } = request.params as { chunkSetId: string };
        if (!isUuid(chunkSetId)) return reply.status(400).send({ error: "bad_chunk_set_id" });

        const [session] = await db
            .select({
                status: uploadSessions.status,
                restore_session_id: uploadSessions.restore_session_id,
            })
            .from(uploadSessions)
            .where(and(eq(uploadSessions.id, chunkSetId), eq(uploadSessions.user_id, userId)))
            .limit(1);

        if (!session) return reply.status(404).send({ error: "no_session" });

        if (session.status === "uploading" || session.status === "restore_staging") {
            const now = nowSec();
            await db
                .update(uploadSessions)
                .set({ updated_at: now })
                .where(eq(uploadSessions.id, chunkSetId));
            if (session.restore_session_id) {
                await db
                    .update(restoreSessions)
                    .set({
                        updated_at: now,
                        expires_at: now + RESTORE_LIMITS.TTL_SECONDS,
                    })
                    .where(
                        and(
                            eq(restoreSessions.id, session.restore_session_id),
                            eq(restoreSessions.status, "open"),
                        ),
                    );
            }
        }

        return reply.send({ ok: true, session_status: session.status });
    });

    // GET /uploads/:chunkSetId/status — the batch status of the chunks in S3
    fastify.get("/uploads/:chunkSetId/status", authChunkMutRl, async (request, reply) => {
        const userId = requireUserId(request);
        const { chunkSetId } = request.params as { chunkSetId: string };
        if (!isUuid(chunkSetId)) return reply.status(400).send({ error: "bad_chunk_set_id" });

        const [session] = await db
            .select({
                status: uploadSessions.status,
                expected_chunks: uploadSessions.expected_chunks,
                total_size: uploadSessions.total_size,
            })
            .from(uploadSessions)
            .where(and(eq(uploadSessions.id, chunkSetId), eq(uploadSessions.user_id, userId)))
            .limit(1);

        if (!session) return reply.status(404).send({ error: "no_session" });

        const listed = await listUploadChunkObjects(userId, chunkSetId);
        const present_indices = listed.map((c) => c.index);
        const total_present_size = listed.reduce((acc, c) => acc + c.size, 0);

        return reply.send({
            session_status: session.status,
            expected_chunks: session.expected_chunks,
            expected_size: session.total_size,
            present_indices,
            total_present_size,
        });
    });

    // POST /uploads/:chunkSetId/finalize — validates and commits the set
    fastify.post("/uploads/:chunkSetId/finalize", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { chunkSetId } = request.params as { chunkSetId: string };
        if (!isUuid(chunkSetId)) return reply.status(400).send({ error: "bad_chunk_set_id" });

        const listed = await listUploadChunkObjects(userId, chunkSetId);
        const parsedChunks = listed.map((c) => ({ idx: c.index, size: c.size }));

        // IMPORTANT: the reply is NOT sent inside the transaction — the response may leave only
        // after the commit, otherwise the client's finalize→file.create races against a chunk set
        // nobody has seen yet.
        const outcome = await db.transaction(
            async (
                tx,
            ): Promise<{ code: 200 | 404 } | { code: 409; detail?: Record<string, number> }> => {
                const [session] = await tx
                    .select({
                        status: uploadSessions.status,
                        expected_chunks: uploadSessions.expected_chunks,
                        total_size: uploadSessions.total_size,
                        restore_session_id: uploadSessions.restore_session_id,
                    })
                    .from(uploadSessions)
                    .where(
                        and(eq(uploadSessions.id, chunkSetId), eq(uploadSessions.user_id, userId)),
                    )
                    .limit(1);

                if (!session) return { code: 404 };
                if (session.status === "committed") return { code: 200 };
                if (session.status !== "uploading" && session.status !== "restore_staging") {
                    return { code: 409 };
                }

                const actualTotalSize = parsedChunks.reduce((acc, p) => acc + p.size, 0);

                // Strict integrity: the keys must form exactly the set 0..expected_chunks-1.
                const validIndices = new Set(
                    parsedChunks
                        .filter(
                            (p) =>
                                Number.isInteger(p.idx) &&
                                p.idx >= 0 &&
                                p.idx < session.expected_chunks,
                        )
                        .map((p) => p.idx),
                );

                if (
                    parsedChunks.length !== session.expected_chunks ||
                    validIndices.size !== session.expected_chunks ||
                    actualTotalSize !== session.total_size
                ) {
                    return {
                        code: 409,
                        detail: {
                            expected_chunks: session.expected_chunks,
                            got_chunks: parsedChunks.length,
                            expected_size: session.total_size,
                            got_size: actualTotalSize,
                        },
                    };
                }

                await tx.insert(chunkSets).values({
                    id: chunkSetId,
                    user_id: userId,
                    chunk_count: session.expected_chunks,
                    total_size: session.total_size,
                    restore_session_id: session.restore_session_id,
                });

                // Filling file_chunks — parsedChunks were validated above (an exact set of indices)
                const chunkRows = parsedChunks.map((p) => ({
                    chunk_set_id: chunkSetId,
                    chunk_index: p.idx,
                    user_id: userId,
                    size: p.size,
                }));
                if (chunkRows.length > 0) {
                    await tx.insert(fileChunks).values(chunkRows);
                }

                await tx
                    .update(uploadSessions)
                    .set({ status: "committed", updated_at: nowSec() })
                    .where(eq(uploadSessions.id, chunkSetId));

                return { code: 200 };
            },
        );

        if (outcome.code === 404) return reply.status(404).send({ error: "no_session" });
        if (outcome.code === 409) {
            return reply.status(409).send({
                error: "incomplete",
                ...("detail" in outcome ? { detail: outcome.detail } : {}),
            });
        }
        return reply.send({ ok: true });
    });

    // DELETE /uploads/:chunkSetId — aborts an upload in flight
    fastify.delete("/uploads/:chunkSetId", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { chunkSetId } = request.params as { chunkSetId: string };
        if (!isUuid(chunkSetId)) return reply.status(400).send({ error: "bad_chunk_set_id" });

        const res = await abortTxn(chunkSetId, userId);
        if (res.code !== 200) {
            const map: Record<number, string> = { 404: "no_session", 409: "already_committed" };
            return reply.status(res.code).send({ error: map[res.code] ?? "error" });
        }

        // Clean the objects out of S3 (best effort — deep-repair picks up the rest)
        await deleteS3Prefix(userId, chunkSetId);

        return reply.send({ ok: true });
    });

    // HEAD /uploads/:chunkSetId/chunks/:index — an existence check with no redirect
    fastify.head("/uploads/:chunkSetId/chunks/:index", authChunkRl, async (request, reply) => {
        const userId = requireUserId(request);
        const params = parseChunkParams(request);
        if (!params.ok) return reply.status(400).send({ error: params.error });
        const { chunkSetId, chunkIndex } = params;

        if (!(await userOwnsChunkSetOrUpload(chunkSetId, userId))) {
            request.log.warn({ chunkSetId, userId }, "HEAD chunk: Ownership validation failed");
            return reply.status(404).send({ error: "not_found" });
        }

        try {
            await s3.send(
                new HeadObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: `u/${userId}/${chunkSetId}/${chunkIndex}`,
                }),
            );
            return reply.status(200).send();
        } catch (e: unknown) {
            const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
            if (
                err.name === "NotFound" ||
                err.$metadata?.httpStatusCode === 404 ||
                err.name === "NoSuchKey"
            ) {
                request.log.warn({ chunkSetId, chunkIndex }, "HEAD chunk: Object missing in S3");
                return reply.status(404).send();
            }
            request.log.error({ err: e }, "HEAD chunk failed with internal error");
            return reply.status(500).send();
        }
    });

    // GET /uploads/:chunkSetId/chunks/:index — downloading one chunk through an S3 presigned-URL redirect
    fastify.get("/uploads/:chunkSetId/chunks/:index", authChunkRl, async (request, reply) => {
        const userId = requireUserId(request);
        const params = parseChunkParams(request);
        if (!params.ok) return reply.status(400).send({ error: params.error });
        const { chunkSetId, chunkIndex } = params;

        // Ownership check
        if (!(await userOwnsChunkSetOrUpload(chunkSetId, userId))) {
            return reply.status(404).send({ error: "not_found" });
        }

        const command = new GetObjectCommand({
            Bucket: S3_BUCKET,
            Key: `u/${userId}/${chunkSetId}/${chunkIndex}`,
            // A chunk's ciphertext is immutable (Replace/Crop creates a new chunkSetId), so the S3
            // response may go into the browser's HTTP cache — otherwise every Range restart by the
            // video player would pull the same chunk off the network again.
            ResponseCacheControl: "private, max-age=3600, immutable",
        });

        // Return JSON carrying a presigned GET URL. We cache it for half the signature's lifetime
        // so a URL with an expired signature never comes out of the cache; a stable URL is also the
        // precondition for the S3 cache above hitting at all (every new signature = a new cache
        // key).
        const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
        reply.header("Cache-Control", "private, max-age=1800, immutable");
        return { url };
    });

    // GET /me/storage — the quota for the UI bar plus the pre-flight
    // One source of truth — storage_used is authoritative (reserved at open, reduced on
    // abort/purge). The previous recalculation from chunk_sets ignored committed orphans and
    // diverged from enforcement. Now: enforcement == what is displayed.
    // A rate limit on the storage read too (to avoid tight-poll abuse).
    const authStorageRl = {
        preParsing: [fastify.authenticateBeforeBody],
        preHandler: [userReadRl],
        config: { rateLimit: ipRateLimit(rlEnv.mutIpMax, rlEnv.mutWindow) },
    };
    fastify.get("/me/storage", authStorageRl, async (request, reply) => {
        const userId = requireUserId(request);

        const [user] = await db
            .select({
                storage_quota: users.storage_quota,
                max_file_size: users.max_file_size,
                storage_used_files: users.storage_used_files,
                storage_used_items: users.storage_used_items,
                storage_used_history: users.storage_used_history,
                storage_used_trash: users.storage_used_trash,
                storage_used: users.storage_used,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        if (!user) return reply.status(401).send({ error: "Unauthorized" });

        const total_items = await countUserItems(db, userId);
        // Seams 2 and 5: the client gets only the plan label and whether it is paid, not a taxonomy of plans.
        const limits = await fastify.entitlements.forUser(db, userId);

        return reply.send({
            storage_quota: user.storage_quota,
            max_file_size: user.max_file_size,
            total_items: total_items,
            plan_label: limits.planLabel,
            // The concrete TTL allowed, not "which plan" — the client only filters the offered
            // options by it and no longer has a plan-dependent branch.
            max_share_ttl_sec: limits.maxShareTtlSec,
            breakdown: {
                files_bytes: user.storage_used_files,
                items_bytes: user.storage_used_items,
                history_bytes: user.storage_used_history,
                trashed_bytes: user.storage_used_trash,
                total_used: user.storage_used,
            },
        });
    });
};

export default fileRoutes;
