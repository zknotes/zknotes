import { isUuid } from "../lib/params";
import {
    createsCycle,
    RESTORE_LIMITS,
    RestoreCommitSchema,
    type RestoreManifestItem,
    type RestoreMode,
    RestoreSessionCreateSchema,
    RestoreSessionItemsSchema,
    type RestoreStagedItem,
    RestoreVerifySchema,
    restoreRemapIdAt,
    topoSortByParent,
} from "@zknotes/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { uuidv7 } from "uuidv7";
import { markPendingDelete } from "../blob-sweeper";
import { db } from "../db";
import {
    chunkSets,
    fileChunks,
    items,
    restoreSessions,
    restoreStagedItems,
    uploadSessions,
    users,
} from "../db/schema";
import { ADVISORY_LOCKS } from "../db/advisory-locks";
import type { DbExecutor } from "../db/types";
import { authenticatedRouteOptions } from "../lib/rate-limit";
import { nowSec } from "../lib/time";
import { parseBody } from "../lib/validate";
import { wireBlobsToRow } from "../lib/wire";
import { requireUserId } from "../plugins/auth";
import {
    buildFolderParentMap,
    countLiveFiles,
    releaseChunkSetIfUnreferenced,
} from "../services/item-service";
import {
    countUserItems,
    getItemStorageSize as itemStorageSize,
    maxFileCount,
    maxItemsCount,
    QuotaExceededError,
    updateQuotaTx,
} from "../services/quota-service";
import { releaseRestoreStaging } from "../services/restore-service";
import { deleteS3Prefix } from "../services/storage-service";

type ItemRow = typeof items.$inferSelect;
type SessionRow = typeof restoreSessions.$inferSelect;
type StagedRow = typeof restoreStagedItems.$inferSelect;

type CollisionKind = "none" | "live" | "trashed" | "purged";

interface RestoreBlocker {
    code: string;
    [key: string]: unknown;
}

interface RestoreVerdict {
    ok: boolean;
    blockers: RestoreBlocker[];
    mode: RestoreMode;
    counts: {
        manifest_items: number;
        collide_live: number;
        collide_trashed: number;
        collide_purged: number;
        /** Purged entries whose remap target already exists — collisions, not new ids. */
        collide_remapped: number;
        creates: number;
        overwrites: number;
        skips: number;
    };
    /** Live and trashed hold remap targets too: a purged entry collides under the id it comes back as. */
    collisions: { live: string[]; trashed: string[]; purged: string[] };
    /** A purged manifest id → the id it comes back under; the client stages under this. */
    remaps: Record<string, string>;
    orphan_parents: Array<{ child_id: string; parent_id: string }>;
    quota: {
        current_used: number;
        quota: number;
        peak_used: number;
        peak_allowed: number;
        peak_ok: boolean;
        final_used: number;
        final_shortfall: number;
        final_ok: boolean;
    };
    ceilings: {
        items: { current: number; incoming_creates: number; limit: number; ok: boolean };
        files: { current: number; incoming_creates: number; limit: number; ok: boolean };
    };
    blobs: { count: number; bytes: number };
    expected_versions: Record<string, number>;
}

class RestoreConflict extends Error {
    constructor(
        public readonly status: 400 | 409 | 404 | 410 | 413 | 429,
        public readonly body: Record<string, unknown>,
    ) {
        super(String(body.error ?? "restore_conflict"));
        this.name = "RestoreConflict";
    }
}

function classify(row: ItemRow | undefined): CollisionKind {
    if (!row) return "none";
    if (row.purged_at != null) return "purged";
    if (row.deleted_at != null) return "trashed";
    return "live";
}

function ttlExpires(now: number): number {
    return now + RESTORE_LIMITS.TTL_SECONDS;
}

async function loadItemsByIds(
    executor: DbExecutor,
    userId: string,
    ids: string[],
): Promise<Map<string, ItemRow>> {
    const out = new Map<string, ItemRow>();
    for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        if (chunk.length === 0) continue;
        const rows = await executor
            .select()
            .from(items)
            .where(and(eq(items.user_id, userId), inArray(items.id, chunk)));
        for (const row of rows) out.set(row.id, row);
    }
    return out;
}

async function loadChunkSizes(
    executor: DbExecutor,
    userId: string,
    chunkSetIds: string[],
): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const unique = [...new Set(chunkSetIds.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 1000) {
        const chunk = unique.slice(i, i + 1000);
        if (chunk.length === 0) continue;
        const rows = await executor
            .select({ id: chunkSets.id, total_size: chunkSets.total_size })
            .from(chunkSets)
            .where(and(eq(chunkSets.user_id, userId), inArray(chunkSets.id, chunk)));
        for (const row of rows) out.set(row.id, Number(row.total_size));
    }
    return out;
}

/**
 * Batched fetch of the chunk-set fields `runVerify`'s per-staged-file blob check needs — the same
 * chunking shape as `loadChunkSizes`, avoiding one `SELECT` per staged file.
 */
async function loadChunkSetDetails(
    executor: DbExecutor,
    userId: string,
    chunkSetIds: string[],
): Promise<Map<string, { restore_session_id: string | null; pending_delete_at: number | null }>> {
    const out = new Map<
        string,
        { restore_session_id: string | null; pending_delete_at: number | null }
    >();
    const unique = [...new Set(chunkSetIds.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 1000) {
        const chunk = unique.slice(i, i + 1000);
        if (chunk.length === 0) continue;
        const rows = await executor
            .select({
                id: chunkSets.id,
                restore_session_id: chunkSets.restore_session_id,
                pending_delete_at: chunkSets.pending_delete_at,
            })
            .from(chunkSets)
            .where(and(eq(chunkSets.user_id, userId), inArray(chunkSets.id, chunk)));
        for (const row of rows) out.set(row.id, row);
    }
    return out;
}

function childWillExist(kind: CollisionKind, mode: RestoreMode): boolean {
    if (mode === "skip_existing") return kind === "none" || kind === "purged";
    return true;
}

function parentLiveAfterCommit(
    parentId: string,
    mode: RestoreMode,
    inBackup: boolean,
    parentKind: CollisionKind,
): boolean {
    if (inBackup) {
        if (mode === "skip_existing" && parentKind === "trashed") return false;
        return true;
    }
    return parentKind === "live";
}

async function reservedStagingBytes(
    executor: DbExecutor,
    sessionId: string,
): Promise<{ items: number; files: number }> {
    const [itemRow] = await executor
        .select({ n: sql<number>`coalesce(sum(${restoreStagedItems.byte_size}), 0)::bigint` })
        .from(restoreStagedItems)
        .where(eq(restoreStagedItems.restore_session_id, sessionId));
    const [uploadRow] = await executor
        .select({ n: sql<number>`coalesce(sum(${uploadSessions.total_size}), 0)::bigint` })
        .from(uploadSessions)
        .where(
            and(
                eq(uploadSessions.restore_session_id, sessionId),
                eq(uploadSessions.status, "restore_staging"),
            ),
        );
    const [csRow] = await executor
        .select({ n: sql<number>`coalesce(sum(${chunkSets.total_size}), 0)::bigint` })
        .from(chunkSets)
        .where(eq(chunkSets.restore_session_id, sessionId));
    return {
        items: Number(itemRow?.n ?? 0),
        files: Number(uploadRow?.n ?? 0) + Number(csRow?.n ?? 0),
    };
}

interface RemapTarget {
    /** The id a purged manifest entry comes back under. */
    id: string;
    /** Its row when that id already exists (live or trashed) — a collision then, not a create. */
    row?: ItemRow;
}

/**
 * Resolves each purged manifest id to the id it comes back under: the first remap generation whose
 * id is not itself purged. A second restore of the same file finds the first one's copy this way,
 * and a copy purged since pushes the item on to the next generation. `null` when every generation
 * up to the limit is purged. One query per generation, for the ids still unresolved only.
 */
async function resolveRemaps(
    executor: DbExecutor,
    userId: string,
    backupHash: string,
    purgedIds: string[],
): Promise<Map<string, RemapTarget | null>> {
    const out = new Map<string, RemapTarget | null>();
    let pending = purgedIds;
    for (
        let generation = 0;
        generation <= RESTORE_LIMITS.MAX_REMAP_GENERATION && pending.length > 0;
        generation++
    ) {
        const candidates = new Map(
            pending.map((id) => [id, restoreRemapIdAt(backupHash, id, generation)]),
        );
        const rows = await loadItemsByIds(executor, userId, [...candidates.values()]);
        const next: string[] = [];
        for (const [original, id] of candidates) {
            const row = rows.get(id);
            if (classify(row) === "purged") next.push(original);
            else out.set(original, row ? { id, row } : { id });
        }
        pending = next;
    }
    for (const original of pending) out.set(original, null);
    return out;
}

async function computeVerdict(
    executor: DbExecutor,
    userId: string,
    backupHash: string,
    manifest: RestoreManifestItem[],
    mode: RestoreMode,
    sessionId?: string,
): Promise<RestoreVerdict> {
    const blockers: RestoreBlocker[] = [];
    const ids = manifest.map((m) => m.id);
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
        blockers.push({ code: "duplicate_manifest_id" });
    }

    const existing = await loadItemsByIds(executor, userId, ids);
    const remapTargets = await resolveRemaps(
        executor,
        userId,
        backupHash,
        manifest.filter((m) => classify(existing.get(m.id)) === "purged").map((m) => m.id),
    );
    const targetRows = [...remapTargets.values()].flatMap((t) => (t?.row ? [t.row] : []));
    const fileCsIds = [...existing.values(), ...targetRows]
        .filter((r) => r.chunk_set_id)
        .map((r) => r.chunk_set_id as string);
    const csSizes = await loadChunkSizes(executor, userId, fileCsIds);

    const live: string[] = [];
    const trashed: string[] = [];
    const purged: string[] = [];
    const exhausted: string[] = [];
    const remaps: Record<string, string> = {};
    const expectedVersions: Record<string, number> = {};
    const inBackup = new Set(ids);
    // What each manifest entry meets on the server: its own row, or — for a purged one — the row of
    // the id it comes back under. The orphan pass below reads the same map.
    const effectiveKind = new Map<string, CollisionKind>();
    let collideRemapped = 0;

    let creates = 0;
    let overwrites = 0;
    let skips = 0;
    let plannedItemBytes = 0;
    let plannedFileBytes = 0;
    let releasedOnCommit = 0;
    let blobCount = 0;
    let blobBytes = 0;
    let itemCreates = 0;
    let fileCreates = 0;
    const orphanParents: Array<{ child_id: string; parent_id: string }> = [];

    for (const entry of manifest) {
        const ownKind = classify(existing.get(entry.id));
        const target = ownKind === "purged" ? remapTargets.get(entry.id) : undefined;
        if (ownKind === "purged") {
            purged.push(entry.id);
            if (target) remaps[entry.id] = target.id;
            else exhausted.push(entry.id);
            if (target?.row) collideRemapped += 1;
        }
        // From here on a purged entry whose target exists is an ordinary collision on that target.
        const collisionId = target ? target.id : entry.id;
        const row = target ? target.row : existing.get(entry.id);
        const kind: CollisionKind = target ? classify(target.row) : ownKind;
        effectiveKind.set(entry.id, kind);
        if (kind === "live") live.push(collisionId);
        else if (kind === "trashed") trashed.push(collisionId);

        if (kind === "live" || kind === "trashed") {
            expectedVersions[collisionId] = row!.version;
        }

        const willStage = mode === "overwrite_all" || kind === "none" || kind === "purged";
        if (kind === "none" || kind === "purged") {
            creates += 1;
            itemCreates += 1;
            if (entry.type === "file") fileCreates += 1;
        } else if (mode === "skip_existing") {
            skips += 1;
        } else {
            overwrites += 1;
            if (kind === "trashed" && entry.type === "file") fileCreates += 1;
            releasedOnCommit += itemStorageSize(row!);
            if (row?.chunk_set_id) releasedOnCommit += csSizes.get(row.chunk_set_id) ?? 0;
        }

        if (willStage) {
            if (entry.type === "file") {
                plannedFileBytes += entry.byte_size;
                blobCount += 1;
                blobBytes += entry.byte_size;
            } else {
                plannedItemBytes += entry.byte_size;
            }
        }
    }

    // A second pass: the parents that are not in the manifest
    const extraParentIds = manifest
        .map((m) => m.parent_id)
        .filter((p): p is string => p != null && !inBackup.has(p));
    const extraParents = await loadItemsByIds(executor, userId, extraParentIds);

    for (const entry of manifest) {
        const kind = effectiveKind.get(entry.id) ?? "none";
        if (!childWillExist(kind, mode) || !entry.parent_id) continue;
        const parentInBackup = inBackup.has(entry.parent_id);
        const parentKind = parentInBackup
            ? (effectiveKind.get(entry.parent_id) ?? "none")
            : classify(extraParents.get(entry.parent_id));
        if (!parentLiveAfterCommit(entry.parent_id, mode, parentInBackup, parentKind)) {
            orphanParents.push({ child_id: entry.id, parent_id: entry.parent_id });
        }
    }

    if (exhausted.length > 0) {
        // Every remap generation of these ids is purged too; there is no id left to restore them under.
        blockers.push({ code: "remap_exhausted", items: exhausted });
    }

    if (orphanParents.length > 0) {
        blockers.push({
            code: "orphan_parent",
            items: orphanParents,
        });
    }

    const [user] = await executor
        .select({
            storage_quota: users.storage_quota,
            storage_used: users.storage_used,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    const quota = user?.storage_quota ?? 0;
    const currentUsed = user?.storage_used ?? 0;
    const reserved = sessionId
        ? await reservedStagingBytes(executor, sessionId)
        : { items: 0, files: 0 };
    const remaining =
        Math.max(0, plannedItemBytes - reserved.items) +
        Math.max(0, plannedFileBytes - reserved.files);
    const peakUsed = currentUsed + remaining;
    const peakAllowed = quota * RESTORE_LIMITS.PEAK_FACTOR;
    const finalUsed = currentUsed + remaining - releasedOnCommit;
    const peakOk = peakUsed <= peakAllowed;
    const finalOk = finalUsed <= quota;
    if (!peakOk) {
        blockers.push({
            code: "quota_peak_exceeded",
            peak_used: peakUsed,
            peak_allowed: peakAllowed,
            shortfall: peakUsed - peakAllowed,
        });
    }
    if (!finalOk) {
        blockers.push({
            code: "quota_final_exceeded",
            final_used: finalUsed,
            quota,
            shortfall: finalUsed - quota,
        });
    }

    const currentItems = await countUserItems(
        executor as Parameters<typeof countUserItems>[0],
        userId,
    );
    const itemLimit = maxItemsCount();
    const itemsOk = currentItems + itemCreates <= itemLimit;
    if (!itemsOk) {
        blockers.push({
            code: "item_limit_exceeded",
            current: currentItems,
            incoming_creates: itemCreates,
            limit: itemLimit,
        });
    }

    const currentFiles = await countLiveFiles(userId, executor);
    const fileLimit = maxFileCount();
    const filesOk = currentFiles + fileCreates <= fileLimit;
    if (!filesOk) {
        blockers.push({
            code: "file_limit_exceeded",
            current: currentFiles,
            incoming_creates: fileCreates,
            limit: fileLimit,
        });
    }

    return {
        ok: blockers.length === 0,
        blockers,
        mode,
        counts: {
            manifest_items: manifest.length,
            collide_live: live.length,
            collide_trashed: trashed.length,
            collide_purged: purged.length,
            collide_remapped: collideRemapped,
            creates,
            overwrites,
            skips,
        },
        collisions: { live, trashed, purged },
        remaps,
        orphan_parents: orphanParents,
        quota: {
            current_used: currentUsed,
            quota,
            peak_used: peakUsed,
            peak_allowed: peakAllowed,
            peak_ok: peakOk,
            final_used: finalUsed,
            final_shortfall: Math.max(0, finalUsed - quota),
            final_ok: finalOk,
        },
        ceilings: {
            items: {
                current: currentItems,
                incoming_creates: itemCreates,
                limit: itemLimit,
                ok: itemsOk,
            },
            files: {
                current: currentFiles,
                incoming_creates: fileCreates,
                limit: fileLimit,
                ok: filesOk,
            },
        },
        blobs: { count: blobCount, bytes: blobBytes },
        expected_versions: expectedVersions,
    };
}

async function getOwnedSession(
    executor: DbExecutor,
    userId: string,
    id: string,
): Promise<SessionRow | undefined> {
    const [row] = await executor
        .select()
        .from(restoreSessions)
        .where(and(eq(restoreSessions.id, id), eq(restoreSessions.user_id, userId)))
        .limit(1);
    return row;
}

async function touchSession(executor: DbExecutor, id: string, now: number): Promise<void> {
    await executor
        .update(restoreSessions)
        .set({ updated_at: now, expires_at: ttlExpires(now) })
        .where(eq(restoreSessions.id, id));
}

async function missingForSession(
    executor: DbExecutor,
    session: SessionRow,
    existing: Map<string, ItemRow>,
): Promise<{ items: string[]; blobs: string[] }> {
    const staged = await executor
        .select({
            id: restoreStagedItems.id,
            type: restoreStagedItems.type,
            chunk_set_id: restoreStagedItems.chunk_set_id,
        })
        .from(restoreStagedItems)
        .where(eq(restoreStagedItems.restore_session_id, session.id));
    const stagedIds = new Set(staged.map((s) => s.id));
    const mode = session.mode as RestoreMode;
    const remapTargets = await resolveRemaps(
        executor,
        session.user_id,
        session.backup_hash,
        session.manifest.filter((m) => classify(existing.get(m.id)) === "purged").map((m) => m.id),
    );
    const missingItems: string[] = [];
    for (const entry of session.manifest) {
        const ownKind = classify(existing.get(entry.id));
        const target = ownKind === "purged" ? remapTargets.get(entry.id) : undefined;
        // `remap_exhausted` already blocks it; there is no id it could be staged under.
        if (target === null) continue;
        // A purged id comes back under its remap, so that is the id the staging has to hold — and
        // when that id exists, it is the collision Skip existing leaves alone.
        const kind = target ? classify(target.row) : ownKind;
        if (mode === "skip_existing" && (kind === "live" || kind === "trashed")) continue;
        const expectedId = target ? target.id : entry.id;
        if (!stagedIds.has(expectedId)) missingItems.push(expectedId);
    }
    const missingBlobs: string[] = [];
    for (const row of staged) {
        if (row.type === "file" && !row.chunk_set_id) missingBlobs.push(row.id);
    }
    return { items: missingItems, blobs: missingBlobs };
}

/**
 * The staged ids the session must refuse: every id outside the manifest, unless it is the proven
 * remap of a manifest id the server has purged for this user — the id `resolveRemaps` gives that
 * original. The proof is recomputed here from `backup_hash`, the client only names the original,
 * and only the originals named in this request are loaded, not the whole manifest.
 */
async function unprovenStagedIds(
    executor: DbExecutor,
    userId: string,
    session: SessionRow,
    staged: RestoreStagedItem[],
): Promise<string[]> {
    const manifestIds = new Set(session.manifest.map((m) => m.id));
    const outside = staged.filter((item) => !manifestIds.has(item.id));
    if (outside.length === 0) return [];
    const originals = await loadItemsByIds(
        executor,
        userId,
        outside
            .map((item) => item.remapped_from)
            .filter((id): id is string => id != null && manifestIds.has(id)),
    );
    // Only a purged original may come back under a new id — a live or trashed one would let the
    // same item be staged under both ids.
    const remapTargets = await resolveRemaps(
        executor,
        userId,
        session.backup_hash,
        [...originals.values()].filter((row) => classify(row) === "purged").map((row) => row.id),
    );
    return outside
        .filter((item) => {
            const original = item.remapped_from;
            if (!original || !manifestIds.has(original)) return true;
            return item.id !== remapTargets.get(original)?.id;
        })
        .map((item) => item.id);
}

/**
 * Whether a staged item's parent will be there, live, and of the right kind after the commit: a
 * file belongs to the note that embeds it, a note or a folder sits under a folder — the same rule
 * as the item routes. It keeps the tree a tree of folders, the folder cycle check meaningful, and
 * every file reachable through its note.
 */
function stagedParentOk(
    row: { type: string; parent_id: string | null },
    stagedTypes: Map<string, string>,
    existing: Map<string, ItemRow>,
): boolean {
    if (!row.parent_id) return true;
    const wanted = row.type === "file" ? "note" : "folder";
    const stagedType = stagedTypes.get(row.parent_id);
    if (stagedType !== undefined) return stagedType === wanted;
    const parent = existing.get(row.parent_id);
    return (
        !!parent && parent.purged_at == null && parent.deleted_at == null && parent.type === wanted
    );
}

const restoreRoutes: FastifyPluginAsync = async (fastify) => {
    const { read: authRead, mut: authMut } = authenticatedRouteOptions(fastify);

    fastify.post("/restore/sessions", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const data = parseBody(RestoreSessionCreateSchema, request, reply);
        if (!data) return;
        const now = nowSec();

        try {
            const result = await db.transaction(async (tx) => {
                const [open] = await tx
                    .select({ id: restoreSessions.id })
                    .from(restoreSessions)
                    .where(
                        and(
                            eq(restoreSessions.user_id, userId),
                            eq(restoreSessions.status, "open"),
                        ),
                    )
                    .limit(1);
                if (open) {
                    throw new RestoreConflict(409, {
                        error: "restore_already_open",
                        restore_session_id: open.id,
                    });
                }

                const verdict = await computeVerdict(
                    tx,
                    userId,
                    data.backup_hash,
                    data.manifest,
                    data.mode,
                );
                const id = uuidv7();
                await tx.insert(restoreSessions).values({
                    id,
                    user_id: userId,
                    backup_hash: data.backup_hash,
                    mode: data.mode,
                    status: "open",
                    manifest: data.manifest,
                    collision_versions: verdict.expected_versions,
                    expires_at: ttlExpires(now),
                    created_at: now,
                    updated_at: now,
                });
                return { restore_session_id: id, verdict };
            });
            return reply.status(201).send(result);
        } catch (e) {
            if (e instanceof RestoreConflict) return reply.status(e.status).send(e.body);
            throw e;
        }
    });

    fastify.get("/restore/sessions/:id", authRead, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        if (!isUuid(id)) return reply.status(400).send({ error: "bad_restore_session_id" });

        const session = await getOwnedSession(db, userId, id);
        if (!session) return reply.status(404).send({ error: "not_found" });

        const now = nowSec();
        if (session.status === "open" && session.expires_at < now) {
            await db
                .update(restoreSessions)
                .set({ status: "expired", updated_at: now })
                .where(eq(restoreSessions.id, id));
            session.status = "expired";
        }

        const existing = await loadItemsByIds(
            db,
            userId,
            session.manifest.map((m) => m.id),
        );
        const missing = await missingForSession(db, session, existing);
        const [stagedCount] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(restoreStagedItems)
            .where(eq(restoreStagedItems.restore_session_id, id));
        const [blobCount] = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(chunkSets)
            .where(eq(chunkSets.restore_session_id, id));
        const verdict = await computeVerdict(
            db,
            userId,
            session.backup_hash,
            session.manifest,
            session.mode as RestoreMode,
            id,
        );

        return reply.send({
            restore_session_id: id,
            status: session.status,
            backup_hash: session.backup_hash,
            mode: session.mode,
            staged_items: stagedCount?.n ?? 0,
            staged_blobs: blobCount?.n ?? 0,
            missing,
            verdict,
            expires_at: session.expires_at,
        });
    });

    fastify.post("/restore/sessions/:id/items", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        if (!isUuid(id)) return reply.status(400).send({ error: "bad_restore_session_id" });
        const data = parseBody(RestoreSessionItemsSchema, request, reply);
        if (!data) return;

        let requestBytes = 0;
        for (const item of data.items) {
            requestBytes += itemStorageSize(item);
        }
        if (requestBytes > RESTORE_LIMITS.MAX_STAGED_BYTES_PER_REQUEST) {
            return reply.status(413).send({ error: "batch_too_large" });
        }

        const now = nowSec();
        try {
            const staged = await db.transaction(async (tx) => {
                const session = await getOwnedSession(tx, userId, id);
                if (!session) throw new RestoreConflict(404, { error: "not_found" });
                if (session.status !== "open") {
                    throw new RestoreConflict(409, {
                        error: "session_not_open",
                        status: session.status,
                    });
                }
                if (session.expires_at < now) {
                    await tx
                        .update(restoreSessions)
                        .set({ status: "expired", updated_at: now })
                        .where(eq(restoreSessions.id, id));
                    throw new RestoreConflict(410, { error: "session_expired" });
                }

                const notInManifest = await unprovenStagedIds(tx, userId, session, data.items);
                if (notInManifest.length > 0) {
                    throw new RestoreConflict(409, {
                        error: "not_in_manifest",
                        ids: notInManifest,
                    });
                }

                const already = await tx
                    .select({ id: restoreStagedItems.id })
                    .from(restoreStagedItems)
                    .where(
                        and(
                            eq(restoreStagedItems.restore_session_id, id),
                            inArray(
                                restoreStagedItems.id,
                                data.items.map((i) => i.id),
                            ),
                        ),
                    );
                const alreadyIds = new Set(already.map((r) => r.id));
                const fresh = data.items.filter((i) => !alreadyIds.has(i.id));
                let reserved = 0;
                if (fresh.length > 0) {
                    const rows = fresh.map((item) => {
                        const blobs = wireBlobsToRow(item);
                        const size = itemStorageSize(item);
                        reserved += size;
                        return {
                            restore_session_id: id,
                            id: item.id,
                            type: item.type,
                            parent_id: item.parent_id,
                            ...blobs,
                            sort_order: item.sort_order,
                            version: item.version,
                            chunk_set_id: item.chunk_set_id ?? null,
                            chunk_count: item.chunk_count ?? null,
                            ciphertext_size: item.ciphertext_size ?? null,
                            byte_size: size,
                            created_at: now,
                        };
                    });
                    try {
                        await updateQuotaTx(tx, userId, { items: reserved }, true, {
                            peakFactor: RESTORE_LIMITS.PEAK_FACTOR,
                        });
                    } catch (e: unknown) {
                        if (e instanceof QuotaExceededError) {
                            throw new RestoreConflict(413, { error: "quota_exceeded" });
                        }
                        throw e;
                    }
                    await tx.insert(restoreStagedItems).values(rows);
                }
                await touchSession(tx, id, now);
                return {
                    staged: fresh.length,
                    skipped: alreadyIds.size,
                };
            });
            return reply.status(200).send(staged);
        } catch (e) {
            if (e instanceof RestoreConflict) return reply.status(e.status).send(e.body);
            throw e;
        }
    });

    fastify.post("/restore/sessions/:id/ping", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        if (!isUuid(id)) return reply.status(400).send({ error: "bad_restore_session_id" });
        const session = await getOwnedSession(db, userId, id);
        if (!session) return reply.status(404).send({ error: "not_found" });
        if (session.status !== "open") {
            return reply.send({ ok: true, session_status: session.status });
        }
        const now = nowSec();
        if (session.expires_at < now) {
            await db
                .update(restoreSessions)
                .set({ status: "expired", updated_at: now })
                .where(eq(restoreSessions.id, id));
            return reply.status(410).send({ error: "session_expired" });
        }
        await touchSession(db, id, now);
        return reply.send({ ok: true, session_status: "open", expires_at: ttlExpires(now) });
    });

    async function runVerify(
        executor: DbExecutor,
        session: SessionRow,
        userId: string,
    ): Promise<{
        ok: boolean;
        blockers: RestoreBlocker[];
        verdict: RestoreVerdict;
        missing: { items: string[]; blobs: string[] };
        version_drift: Array<{ id: string; expected: number; actual: number }>;
        staged: StagedRow[];
    }> {
        const verdict = await computeVerdict(
            executor,
            userId,
            session.backup_hash,
            session.manifest,
            session.mode as RestoreMode,
            session.id,
        );
        const staged = await executor
            .select()
            .from(restoreStagedItems)
            .where(eq(restoreStagedItems.restore_session_id, session.id));
        const stagedIds = new Set(staged.map((s) => s.id));
        const stagedTypes = new Map(staged.map((s) => [s.id, s.type]));
        const parentIds = staged.map((s) => s.parent_id).filter((p): p is string => p != null);
        const existing = await loadItemsByIds(executor, userId, [
            ...session.manifest.map((m) => m.id),
            ...[...stagedIds],
            ...parentIds,
            // A remap target a skip leaves alone is guarded by version too, yet it is neither a
            // manifest id nor staged — without its row it would read as a drift.
            ...Object.keys(session.collision_versions ?? {}),
        ]);
        const missing = await missingForSession(executor, session, existing);
        const blockers: RestoreBlocker[] = [...verdict.blockers];
        if (missing.items.length > 0 || missing.blobs.length > 0) {
            blockers.push({ code: "incomplete_staging", missing });
        }

        const versionDrift: Array<{ id: string; expected: number; actual: number }> = [];
        const expected = session.collision_versions ?? {};
        for (const [itemId, exp] of Object.entries(expected)) {
            const row = existing.get(itemId);
            if (!row) {
                versionDrift.push({ id: itemId, expected: exp, actual: -1 });
                continue;
            }
            if (row.version !== exp) {
                versionDrift.push({ id: itemId, expected: exp, actual: row.version });
            }
        }
        if (versionDrift.length > 0) {
            blockers.push({ code: "version_drift", items: versionDrift });
        }

        // A restore overwrites an existing row's content, never its type. Letting the type change
        // would turn a folder into a note with its children still under it, past the cycle check,
        // which goes by the staged type. Live rows and rows in the trash alike.
        const typeChanged: Array<{ id: string; stored: string; staged: string }> = [];
        for (const row of staged) {
            const current = existing.get(row.id);
            if (current && current.purged_at == null && current.type !== row.type) {
                typeChanged.push({ id: row.id, stored: current.type, staged: row.type });
            }
        }
        if (typeChanged.length > 0) {
            blockers.push({ code: "item_type_changed", items: typeChanged });
        }

        const stagedOrphans: Array<{ child_id: string; parent_id: string }> = [];
        for (const row of staged) {
            if (!stagedParentOk(row, stagedTypes, existing)) {
                stagedOrphans.push({ child_id: row.id, parent_id: row.parent_id as string });
            }
        }
        if (stagedOrphans.length > 0) {
            blockers.push({ code: "orphan_parent", items: stagedOrphans });
        }

        const csDetails = await loadChunkSetDetails(
            executor,
            userId,
            staged
                .filter((r) => r.type === "file" && r.chunk_set_id)
                .map((r) => r.chunk_set_id as string),
        );
        for (const row of staged) {
            if (row.type !== "file") continue;
            if (!row.chunk_set_id) continue;
            const cs = csDetails.get(row.chunk_set_id);
            if (!cs || cs.pending_delete_at != null || cs.restore_session_id !== session.id) {
                blockers.push({ code: "incomplete_blob", item_id: row.id });
            }
        }

        return {
            ok: blockers.length === 0,
            blockers,
            verdict,
            missing,
            version_drift: versionDrift,
            staged,
        };
    }

    fastify.post("/restore/sessions/:id/verify", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        if (!isUuid(id)) return reply.status(400).send({ error: "bad_restore_session_id" });
        // RestoreVerifySchema is .optional() — success legitimately returns undefined (an empty
        // body), so a falsy check (`!parsed`) is wrong: it would treat a failed validation (null)
        // and a successful empty body the same, and silently answer 200 without doing any work.
        if (parseBody(RestoreVerifySchema, request, reply) === null) return;

        const session = await getOwnedSession(db, userId, id);
        if (!session) return reply.status(404).send({ error: "not_found" });
        if (session.status !== "open") {
            return reply.status(409).send({ error: "session_not_open", status: session.status });
        }
        const now = nowSec();
        if (session.expires_at < now) {
            await db
                .update(restoreSessions)
                .set({ status: "expired", updated_at: now })
                .where(eq(restoreSessions.id, id));
            return reply.status(410).send({ error: "session_expired" });
        }

        const result = await runVerify(db, session, userId);
        if (result.ok) {
            await db
                .update(restoreSessions)
                .set({
                    collision_versions: result.verdict.expected_versions,
                    updated_at: now,
                    expires_at: ttlExpires(now),
                })
                .where(eq(restoreSessions.id, id));
        }
        return reply.send({
            ok: result.ok,
            blockers: result.blockers,
            verdict: result.verdict,
            missing: result.missing,
            version_drift: result.version_drift,
        });
    });

    fastify.post("/restore/sessions/:id/commit", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        if (!isUuid(id)) return reply.status(400).send({ error: "bad_restore_session_id" });
        // The same reason as /verify: RestoreCommitSchema is .optional(), so null (a failure) must
        // not be confused with a legitimate undefined (a successful empty body).
        if (parseBody(RestoreCommitSchema, request, reply) === null) return;
        const now = nowSec();

        try {
            const committed = await db.transaction(async (tx) => {
                await tx.execute(
                    sql`SELECT set_config('statement_timeout', ${String(RESTORE_LIMITS.COMMIT_STATEMENT_TIMEOUT_MS)}, true)`,
                );
                const session = await getOwnedSession(tx, userId, id);
                if (!session) throw new RestoreConflict(404, { error: "not_found" });
                if (session.status !== "open") {
                    throw new RestoreConflict(409, {
                        error: "session_not_open",
                        status: session.status,
                    });
                }
                if (session.expires_at < now) {
                    await tx
                        .update(restoreSessions)
                        .set({ status: "expired", updated_at: now })
                        .where(eq(restoreSessions.id, id));
                    throw new RestoreConflict(410, { error: "session_expired" });
                }

                const verified = await runVerify(tx, session, userId);
                if (!verified.ok) {
                    throw new RestoreConflict(409, {
                        error: "verify_failed",
                        blockers: verified.blockers,
                    });
                }

                const staged = verified.staged;
                const sorted = topoSortByParent(staged, (s) => s.parent_id);
                const pendingFolders = staged.filter((s) => s.type === "folder");
                if (pendingFolders.length > 0) {
                    await tx.execute(
                        sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCKS.folderMutation}, hashtext(${userId}))`,
                    );
                    const projectedMap = await buildFolderParentMap(userId, tx);
                    for (const row of pendingFolders) {
                        projectedMap.set(row.id, row.parent_id);
                    }
                    // The stored folder graph is already acyclic by construction — a NEW cycle can
                    // only be introduced through an edge that changed in this request, i.e. one of
                    // `pendingFolders` (the full map is still passed as the lookup for createsCycle
                    // to walk internally).
                    for (const row of pendingFolders) {
                        if (createsCycle(row.id, row.parent_id, projectedMap)) {
                            throw new RestoreConflict(400, {
                                error: "Cycle detected in folder hierarchy",
                            });
                        }
                    }
                }
                const existing = await loadItemsByIds(
                    tx,
                    userId,
                    sorted.map((s) => s.id),
                );

                let dItems = 0;
                let dTrash = 0;
                // The chunk sets the restore replaces, each once, with the bucket its bytes sit in: a
                // set is counted under files while any item referencing it is live.
                const replacedSets = new Map<string, "files" | "trash">();

                for (const row of sorted) {
                    const current = existing.get(row.id);
                    if (current?.purged_at) {
                        throw new RestoreConflict(409, {
                            error: "item_permanently_deleted",
                            id: row.id,
                        });
                    }
                    const newSize = itemStorageSize(row);
                    if (!current) {
                        void newSize;
                        continue;
                    }
                    const oldSize = itemStorageSize(current);
                    const wasTrash = current.deleted_at != null;
                    if (wasTrash) dTrash -= oldSize;
                    else dItems -= oldSize;

                    if (current.chunk_set_id && current.chunk_set_id !== row.chunk_set_id) {
                        const bucket = wasTrash ? "trash" : "files";
                        if (replacedSets.get(current.chunk_set_id) !== "files") {
                            replacedSets.set(current.chunk_set_id, bucket);
                        }
                    }
                }

                const expected = session.collision_versions ?? {};
                const chunkSize = RESTORE_LIMITS.COMMIT_CHUNK_SIZE;
                for (let i = 0; i < sorted.length; i += chunkSize) {
                    const slice = sorted.slice(i, i + chunkSize);
                    const values = slice.map((row) => {
                        const current = existing.get(row.id);
                        const versionForInsert = current
                            ? (expected[row.id] ?? current.version)
                            : 1;
                        return {
                            id: row.id,
                            user_id: userId,
                            type: row.type,
                            parent_id: row.parent_id,
                            encrypted_payload: row.encrypted_payload,
                            payload_nonce: row.payload_nonce,
                            encrypted_item_key: row.encrypted_item_key,
                            item_key_nonce: row.item_key_nonce,
                            sort_order: row.sort_order,
                            version: versionForInsert,
                            chunk_set_id: row.chunk_set_id,
                            chunk_count: row.chunk_count,
                            ciphertext_size: row.ciphertext_size,
                            deleted_at: null,
                            trashed_batch_id: null,
                            created_at: now,
                            updated_at: now,
                        };
                    });
                    const returned = await tx
                        .insert(items)
                        .values(values)
                        .onConflictDoUpdate({
                            target: items.id,
                            set: {
                                parent_id: sql`excluded.parent_id`,
                                encrypted_payload: sql`excluded.encrypted_payload`,
                                payload_nonce: sql`excluded.payload_nonce`,
                                encrypted_item_key: sql`excluded.encrypted_item_key`,
                                item_key_nonce: sql`excluded.item_key_nonce`,
                                sort_order: sql`excluded.sort_order`,
                                chunk_set_id: sql`excluded.chunk_set_id`,
                                chunk_count: sql`excluded.chunk_count`,
                                ciphertext_size: sql`excluded.ciphertext_size`,
                                deleted_at: sql`NULL`,
                                trashed_batch_id: sql`NULL`,
                                version: sql`${items.version} + 1`,
                                updated_at: sql`excluded.updated_at`,
                            },
                            setWhere: sql`${items.user_id} = ${userId} AND ${items.purged_at} IS NULL AND ${items.version} = excluded.version`,
                        })
                        .returning({ id: items.id });
                    if (returned.length !== slice.length) {
                        throw new RestoreConflict(409, { error: "version_drift" });
                    }
                }

                // After the upserts, so the restored rows already point at their new sets. A set
                // that another item still references — a conflict copy shares its original's set by
                // design — is not released; its bytes stay counted.
                for (const [csId, bucket] of replacedSets) {
                    await releaseChunkSetIfUnreferenced(tx, csId, userId, undefined, { bucket });
                }

                await tx
                    .update(chunkSets)
                    .set({ restore_session_id: null })
                    .where(eq(chunkSets.restore_session_id, id));

                await tx
                    .delete(restoreStagedItems)
                    .where(eq(restoreStagedItems.restore_session_id, id));

                await updateQuotaTx(tx, userId, { items: dItems, trash: dTrash }, true);

                await tx
                    .update(restoreSessions)
                    .set({ status: "committed", updated_at: now })
                    .where(eq(restoreSessions.id, id));

                return { committed_items: sorted.length };
            });
            return reply.send({ ok: true, restore_session_id: id, ...committed });
        } catch (e) {
            if (e instanceof RestoreConflict) return reply.status(e.status).send(e.body);
            throw e;
        }
    });

    fastify.post("/restore/sessions/:id/abort", authMut, async (request, reply) => {
        const userId = requireUserId(request);
        const { id } = request.params as { id: string };
        if (!isUuid(id)) return reply.status(400).send({ error: "bad_restore_session_id" });
        const now = nowSec();

        const prefixes = await db
            .transaction(async (tx) => {
                const session = await getOwnedSession(tx, userId, id);
                if (!session) throw new RestoreConflict(404, { error: "not_found" });
                if (session.status === "committed") {
                    throw new RestoreConflict(409, { error: "already_committed" });
                }
                if (session.status === "aborted")
                    return [] as Array<{ userId: string; id: string }>;
                const { prefixes: p } = await releaseRestoreStaging(tx, session);
                await tx
                    .update(restoreSessions)
                    .set({ status: "aborted", updated_at: now })
                    .where(eq(restoreSessions.id, id));
                return p;
            })
            .catch((e) => {
                if (e instanceof RestoreConflict) return e;
                throw e;
            });
        if (prefixes instanceof RestoreConflict) {
            return reply.status(prefixes.status).send(prefixes.body);
        }
        for (const p of prefixes) {
            await deleteS3Prefix(p.userId, p.id);
        }
        return reply.send({ ok: true });
    });
};

export default restoreRoutes;
