// The client upload pipeline: open a session → encrypt+PUT the chunks → finalize → commit the file
// item. The encrypted manifest lives inside the item payload.
import { type ChunkRef, FILE_LIMITS } from "@zknotes/shared";
import { uuidv7 } from "uuidv7";
import {
    finalizeUpload,
    getUploadStatus,
    isPermanentStorageRejection,
    isPresignRejected,
    mintUploadUrls,
    openUpload,
    openUploadSession,
    putChunk,
} from "$lib/core/api";
import { getDB, type LocalItem, type PendingUpload } from "$lib/core/db";
import { evictChunkSet } from "$lib/core/files/chunk-loader";
import { enqueueMutation, pushItem } from "$lib/core/sync";
import { fromBase64, toBase64 } from "$lib/core/utils/base64";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";
import {
    addCachedItemKey,
    encryptChunkTask,
    encryptPayloadTask,
    generateItemKeyTask,
} from "$lib/core/workers/crypto-rpc";
import { getMaxFileSizeMB, isOverFileSizeLimit } from "./limits";
import { isRasterImageMime } from "./sniff";
import { deleteStaging } from "./opfs-staging";
import {
    deleteAllUploadChunks,
    deleteUploadChunk,
    loadUploadChunk,
    persistUploadChunk,
} from "./upload-chunk-store";
import {
    classifyUploadError,
    isUserAbort,
    retryBackoffMs,
    sleep,
    UploadPipelineError,
} from "./upload-errors";
import { createActiveHeartbeat } from "./upload-heartbeat";
import { assertUploadFence, renewUploadLock } from "./upload-lock";
import { allChunksPresentOnS3, reconcileManifestWithStatus } from "./upload-reconcile";
import {
    readPlaintextSlice,
    type UploadSource,
    uploadSourceFromFile,
    uploadSourceFromPending,
} from "./upload-source";
import { cleanupLocalPendingRow } from "./upload-session-cleanup";
import {
    chunkPlan,
    type ManifestChunkEntry,
    normalizePending,
    ownerNoteState,
} from "./upload-state";
import { throttleBetweenChunks } from "./upload-visibility";

export interface UploadProgress {
    phase: "encrypting" | "uploading" | "finalizing" | "committing" | "done";
    chunkIndex?: number;
    totalChunks?: number;
    chunkPct?: number;
}

/**
 * Overall 0–100 display progress for an in-flight upload.
 *
 * - encrypting chunk i → only completed previous chunks count (i / N)
 * - uploading chunk i at p% → (i + p/100) / N
 * - finalizing / committing / done → 100
 *
 * Never invents progress for the current chunk during encrypt (that used to
 * jump the bar ahead then snap back when the PUT started).
 */
export function computeUploadDisplayPct(p: {
    phase: UploadProgress["phase"];
    chunkIndex?: number;
    totalChunks?: number;
    chunkPct?: number;
}): number | null {
    const total = p.totalChunks ?? 0;
    if (total <= 0) return null;
    if (p.phase === "finalizing" || p.phase === "committing" || p.phase === "done") {
        return 100;
    }
    const chunkIndex = Math.max(0, Math.min(total, p.chunkIndex ?? 0));
    // Only the wire PUT contributes within-chunk progress; encrypt is 0 of current chunk.
    const within = p.phase === "uploading" ? Math.min(100, Math.max(0, p.chunkPct ?? 0)) : 0;
    return Math.min(100, Math.max(0, Math.round((chunkIndex * 100 + within) / total)));
}

export interface UploadOptions {
    onProgress?: (p: UploadProgress) => void;
    description?: string;
    /** Interrupts an upload in progress between chunks; the session is aborted and reclaimed. */
    signal?: AbortSignal;
    /** Backup restore: keep the original item ID instead of generating a new one. */
    itemId?: string;
    /** Backup restore: keep the original sort_order. */
    sortOrder?: string;
    /** Backup restore: keep the original created_at unix timestamp. */
    createdAt?: number;
    /**
     * A backup restore / overwrite: the optimistic-concurrency version that has to match the server's.
     * If it is not given and the item already exists locally, existing.version is used.
     */
    version?: number;
    /** Set when the upload comes from the pending-uploads queue — it enables persisting the IDB manifest. */
    pendingLocalId?: string;
    /**
     * The multi-tab fence from `acquireUploadLock`. It has to match the IDB `upload_lock.fence`
     * on renew, finalize or create — otherwise the old tab gives up after a takeover.
     */
    uploadFence?: number;
    /** The restore wizard: the blob staging tied to the restore session. */
    restoreSessionId?: string;
    /**
     * The restore wizard: finalize the blob and encrypt the file item, but do NOT write to the local vault
     * nor to the mutation queue — the server does the commit.
     */
    stageOnly?: boolean;
}

const MAX_CHUNK_RETRIES = 8;
// A request the object store refuses outright gets one freshly minted URL, then the upload fails.
const MAX_PERMANENT_REJECTIONS = 2;
const LOCK_RENEW_INTERVAL_MS = 30_000;

async function sha256Base64(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return toBase64(new Uint8Array(digest));
}

async function persistPendingPatch(
    localId: string | undefined,
    patch: Partial<PendingUpload>,
): Promise<void> {
    if (!localId) return;
    const db = await getDB();
    const existing = await db.get("pending-uploads", localId);
    if (!existing) return;
    await db.put("pending-uploads", {
        ...existing,
        ...patch,
        last_activity_at: Date.now(),
    });
}

async function persistManifestEntry(
    localId: string | undefined,
    index: number,
    entry: ManifestChunkEntry,
    manifest: Record<number, ManifestChunkEntry>,
): Promise<void> {
    manifest[index] = entry;
    if (!localId) return;
    // Merge ONE entry into the stored map rather than writing this tab's whole in-memory map. After a
    // lease takeover the old tab's late write would otherwise clobber the entries the new tab has
    // already stored (last-writer-wins on the entire manifest), and a crash of the new tab before its
    // next write would resume from a manifest missing chunks that are already on S3.
    const db = await getDB();
    const existing = await db.get("pending-uploads", localId);
    if (!existing) return;
    await db.put("pending-uploads", {
        ...existing,
        manifest: { ...(existing.manifest ?? {}), [index]: entry },
        last_activity_at: Date.now(),
    });
}

/**
 * The fence check before finalize/commit. A RENEW rather than a bare assert: `assertUploadFence`
 * also demands lease freshness (<60 s since the last renew), but the lease is renewed only between
 * chunks — one slow 5 MiB PUT (or a long retry backoff) on the last chunk let the lease age past 60 s
 * with nobody taking over, and the whole upload was then reported as "taken over by another tab".
 * `renewUploadLock` checks exactly what matters (this tab still owns this fence) and refreshes the
 * lease. Fence 0 = no queue row to fence (an ephemeral upload) — the assert's own no-op token.
 */
async function ensureUploadFence(localId: string, fence: number): Promise<boolean> {
    if (fence === 0) return assertUploadFence(localId, fence);
    return renewUploadLock(localId, fence);
}

/**
 * The presigned PUT for one chunk: a pre-minted URL (the replace path mints them all up front), a
 * cached lazily-minted one, or a fresh mint. `stale` holds the indices whose URL the object store
 * has already rejected — a presigned URL lives `PRESIGNED_PUT_EXPIRES_SEC` (5 min), so a large
 * replace or a long retry backoff outlives it; those indices are always minted again.
 */
async function resolvePutUrl(
    chunkSetId: string,
    index: number,
    putUrls: string[] | undefined,
    urlCache: Map<number, string>,
    stale: Set<number>,
): Promise<string> {
    const preminted = putUrls?.[index];
    if (preminted && !stale.has(index)) return preminted;
    const cached = urlCache.get(index);
    if (cached) return cached;
    const minted = await mintUploadUrls(chunkSetId, [index]);
    const url = minted[0]?.put_url;
    if (!url) throw new Error(`Failed to mint PUT URL for chunk ${index}`);
    urlCache.set(index, url);
    return url;
}

/**
 * Encrypts and uploads a file's chunks into an already-open chunk set, then finalizes.
 * Transient errors are retried with a backoff; the session is aborted only on a user AbortSignal.
 */
export async function uploadChunks(params: {
    source: UploadSource;
    itemId: string;
    chunkSetId: string;
    putUrls?: string[];
    totalChunks: number;
    chunkSize: number;
    onProgress: (p: UploadProgress) => void;
    signal?: AbortSignal;
    pendingLocalId?: string;
    /** See UploadOptions.uploadFence. */
    uploadFence?: number;
    startIndex?: number;
    confirmedIndices?: Set<number>;
    existingManifest?: Record<number, ManifestChunkEntry>;
    ciphertextCache?: Map<number, Uint8Array>;
    /**
     * Abort the session on any failure, not only a user abort: for an upload nothing can resume. A
     * restore upload has no pending row, and its session would otherwise stay `restore_staging`,
     * holding its quota and one of the restore's parallel slots until the restore ends.
     */
    abortSessionOnFailure?: boolean;
}): Promise<ChunkRef[]> {
    const {
        source,
        itemId,
        chunkSetId,
        putUrls,
        totalChunks,
        chunkSize,
        onProgress,
        signal,
        pendingLocalId,
        uploadFence,
        startIndex = 0,
        confirmedIndices = new Set<number>(),
        existingManifest = {},
    } = params;

    const manifest: Record<number, ManifestChunkEntry> = { ...existingManifest };
    const ciphertextCache = params.ciphertextCache ?? new Map<number, Uint8Array>();
    const urlCache = new Map<number, string>();
    const stalePutUrls = new Set<number>();
    let lastLockRenew = Date.now();
    const heartbeat = createActiveHeartbeat(chunkSetId);

    try {
        for (let i = 0; i < totalChunks; i++) {
            await heartbeat.tick();
            await throttleBetweenChunks();
            const existing = manifest[i];
            if (confirmedIndices.has(i) || existing?.local_state === "confirmed") {
                continue;
            }
            if (i < startIndex) continue;

            if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");

            if (
                pendingLocalId &&
                uploadFence !== undefined &&
                Date.now() - lastLockRenew >= LOCK_RENEW_INTERVAL_MS
            ) {
                const stillOurs = await renewUploadLock(pendingLocalId, uploadFence);
                if (!stillOurs) {
                    throw new UploadPipelineError(
                        "Upload taken over by another tab",
                        "fatal_session",
                        "failed_expired",
                    );
                }
                lastLockRenew = Date.now();
            }

            let attempt = 0;
            let permanentRejections = 0;
            let chunkDone = false;

            while (!chunkDone && attempt < MAX_CHUNK_RETRIES) {
                if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
                attempt++;

                try {
                    onProgress({ phase: "encrypting", chunkIndex: i, totalChunks, chunkPct: 0 });

                    let ciphertext = ciphertextCache.get(i);
                    let nonceB64: string;
                    let hash: string;

                    if (existing?.local_state === "persisted" && existing.nonce) {
                        nonceB64 = existing.nonce;
                        hash = existing.hash;
                        ciphertext = ciphertextCache.get(i);
                        if (!ciphertext && pendingLocalId) {
                            const staged = await loadUploadChunk(pendingLocalId, i);
                            if (staged) {
                                ciphertext = staged.ciphertext;
                                ciphertextCache.set(i, staged.ciphertext);
                                nonceB64 = staged.nonce;
                                hash = staged.hash;
                            }
                        }
                        if (!ciphertext) {
                            throw new UploadPipelineError(
                                "Missing local ciphertext for persisted chunk",
                                "fatal_integrity",
                                "failed_expired",
                            );
                        }
                    } else {
                        const start = i * chunkSize;
                        const plainLen = Math.min(chunkSize, source.size - start);
                        const plaintext = await readPlaintextSlice(source, start, plainLen);
                        const { ciphertext: ct, nonce } = await encryptChunkTask(
                            itemId,
                            chunkSetId,
                            i,
                            totalChunks,
                            plaintext,
                        );
                        ciphertext = ct;
                        ciphertextCache.set(i, ct);
                        nonceB64 = toBase64(nonce);
                        hash = await sha256Base64(ct);
                    }

                    if (pendingLocalId) {
                        await persistUploadChunk(pendingLocalId, i, ciphertext, nonceB64, hash);
                    }

                    await persistManifestEntry(
                        pendingLocalId,
                        i,
                        {
                            nonce: nonceB64,
                            hash,
                            size: ciphertext.byteLength,
                            local_state: "persisted",
                        },
                        manifest,
                    );

                    onProgress({ phase: "uploading", chunkIndex: i, totalChunks, chunkPct: 0 });
                    const putUrl = await resolvePutUrl(
                        chunkSetId,
                        i,
                        putUrls,
                        urlCache,
                        stalePutUrls,
                    );
                    await putChunk(putUrl, ciphertext, (loaded, total) => {
                        if (signal?.aborted) return;
                        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
                        onProgress({
                            phase: "uploading",
                            chunkIndex: i,
                            totalChunks,
                            chunkPct: pct,
                        });
                        // Keep the lease alive DURING a long PUT too (a 5 MiB chunk on a slow link
                        // outlives the 60 s lease), so another tab does not see it expired and take
                        // over an upload that is still making progress. Fire-and-forget: a failed
                        // renew (a real takeover) is caught at the next chunk boundary.
                        if (
                            pendingLocalId &&
                            uploadFence !== undefined &&
                            uploadFence !== 0 &&
                            Date.now() - lastLockRenew >= LOCK_RENEW_INTERVAL_MS
                        ) {
                            lastLockRenew = Date.now();
                            void renewUploadLock(pendingLocalId, uploadFence).catch(() => {});
                        }
                    });

                    await persistManifestEntry(
                        pendingLocalId,
                        i,
                        {
                            nonce: nonceB64,
                            hash,
                            size: ciphertext.byteLength,
                            local_state: "confirmed",
                        },
                        manifest,
                    );
                    if (pendingLocalId) {
                        await deleteUploadChunk(pendingLocalId, i);
                    }
                    ciphertextCache.delete(i);
                    chunkDone = true;
                } catch (err) {
                    // The object store refused the signature (expired presign, most often): the
                    // retry must not reuse that URL, pre-minted or cached — mint it again.
                    // A permanent rejection gets a fresh URL too — the one retry it is allowed must not
                    // resend the exact request that was just refused.
                    const permanent = isPermanentStorageRejection(err);
                    if (isPresignRejected(err) || permanent) {
                        stalePutUrls.add(i);
                        urlCache.delete(i);
                    }
                    const errorClass = classifyUploadError(err);
                    if (errorClass === "user") throw err;
                    if (errorClass === "fatal_session") {
                        throw new UploadPipelineError(
                            err instanceof Error ? err.message : "Upload session expired",
                            errorClass,
                            "failed_expired",
                        );
                    }
                    if (errorClass === "fatal_quota") {
                        throw new UploadPipelineError(
                            err instanceof Error ? err.message : "Storage quota exceeded",
                            errorClass,
                            "failed_recoverable",
                        );
                    }
                    if (errorClass === "fatal_integrity") throw err;
                    // Before the retry cap: a refusal that repeats on a fresh URL will not change in
                    // the next minutes either, and `paused` would only schedule it again later.
                    if (permanent && ++permanentRejections >= MAX_PERMANENT_REJECTIONS) {
                        throw new UploadPipelineError(
                            err instanceof Error ? err.message : "Upload refused by file storage",
                            "fatal_storage",
                            "failed_recoverable",
                        );
                    }
                    if (attempt >= MAX_CHUNK_RETRIES) {
                        await persistPendingPatch(pendingLocalId, {
                            phase: "paused",
                            last_error: err instanceof Error ? err.message : "Upload paused",
                        });
                        throw new UploadPipelineError(
                            err instanceof Error ? err.message : "Upload paused after retries",
                            "transient",
                            "paused",
                        );
                    }
                    await sleep(retryBackoffMs(attempt));
                }
            }
        }

        onProgress({ phase: "finalizing" });
        await persistPendingPatch(pendingLocalId, { phase: "finalizing" });
        if (pendingLocalId && uploadFence !== undefined) {
            const stillOurs = await ensureUploadFence(pendingLocalId, uploadFence);
            if (!stillOurs) {
                throw new UploadPipelineError(
                    "Upload taken over by another tab",
                    "fatal_session",
                    "failed_expired",
                );
            }
        }
        await heartbeat.tick();
        await finalizeUpload(chunkSetId);
        // The finalize succeeded → the blob is committed. If committing the item fails, the resume goes
        // through orphan_committed (not an abort — the server answers 409 already_committed).
        await persistPendingPatch(pendingLocalId, { phase: "orphan_committed" });
    } catch (err) {
        if (isUserAbort(err)) {
            const { abortUpload } = await import("$lib/core/api/files");
            await abortUpload(chunkSetId);
            await persistPendingPatch(pendingLocalId, { phase: "user_aborted" });
        } else if (params.abortSessionOnFailure) {
            const { abortUpload } = await import("$lib/core/api/files");
            await abortUpload(chunkSetId);
        }
        throw err;
    } finally {
        heartbeat.stop();
    }

    const result: ChunkRef[] = [];
    for (let i = 0; i < totalChunks; i++) {
        const entry = manifest[i];
        if (entry) {
            result.push({ nonce: entry.nonce, hash: entry.hash, size: entry.size });
        }
    }
    return result;
}

async function commitUploadedFile(params: {
    source: UploadSource;
    fileItemId: string;
    chunkSetId: string;
    manifest: ChunkRef[];
    chunkSize: number;
    totalChunks: number;
    ciphertextSize: number;
    parentId: string | null;
    opts: UploadOptions;
    encryptedItemKey: number[];
    itemKeyNonce: number[];
    /** The optimistic-concurrency version (1 for new ones; existing.version for a restore overwrite). */
    version: number;
    /** The localRev for an overwrite — bump it so an in-flight applySucceeded does not clear dirty. */
    localRev: number;
    thumbnailB64?: string;
    /** A raster image's intrinsic dimensions (anti-CLS). */
    imageWidth?: number;
    imageHeight?: number;
    onProgress: (p: UploadProgress) => void;
    pendingLocalId?: string;
    stagingId?: string;
}): Promise<LocalItem> {
    const {
        source,
        fileItemId,
        chunkSetId,
        manifest,
        chunkSize,
        totalChunks,
        ciphertextSize,
        parentId,
        opts,
        encryptedItemKey,
        itemKeyNonce,
        version,
        localRev,
        thumbnailB64,
        imageWidth,
        imageHeight,
        onProgress,
        pendingLocalId,
        stagingId,
    } = params;

    const payload: Record<string, unknown> = {
        kind: "file",
        chunkSetId,
        name: source.name,
        mime: source.mime,
        size: source.size,
        chunkSize,
        chunks: manifest,
    };
    if (thumbnailB64) payload.thumbnail = thumbnailB64;
    if (imageWidth && imageHeight) {
        payload.width = imageWidth;
        payload.height = imageHeight;
    }
    if (opts.description) payload.description = opts.description;

    try {
        if (pendingLocalId && opts.uploadFence !== undefined) {
            const stillOurs = await ensureUploadFence(pendingLocalId, opts.uploadFence);
            if (!stillOurs) {
                throw new UploadPipelineError(
                    "Upload taken over by another tab",
                    "fatal_session",
                    "failed_expired",
                );
            }
        }

        if (parentId && !opts.stageOnly) {
            const db = await getDB();
            const parent = await db.get("items", parentId);
            if (parent?.type === "note" && FileLifecycle.stateOf(parent) !== "READY") {
                // The blob is already committed — do not abort (409). Leave orphan_committed for GC and resume.
                await persistPendingPatch(pendingLocalId, {
                    phase: "orphan_committed",
                    last_error: "Owner note was deleted",
                });
                throw new UploadPipelineError(
                    "Owner note was deleted",
                    "fatal_session",
                    "failed_expired",
                );
            }
        }

        // The version has to match the one that will be stored, and the server's optimistic check.
        const { ciphertext, nonce } = await encryptPayloadTask(fileItemId, payload, version);

        onProgress({ phase: "committing" });
        await persistPendingPatch(pendingLocalId, { phase: "committing_item" });

        // No deleted_at or purged_at — a restore from a backup returns the file to READY, trash state included.
        const item: LocalItem = {
            id: fileItemId,
            parent_id: parentId,
            type: "file",
            encrypted_payload: toBase64(new Uint8Array(ciphertext)),
            payload_nonce: toBase64(new Uint8Array(nonce)),
            encrypted_item_key: toBase64(new Uint8Array(encryptedItemKey)),
            item_key_nonce: toBase64(new Uint8Array(itemKeyNonce)),
            chunk_set_id: chunkSetId,
            chunk_count: totalChunks,
            ciphertext_size: ciphertextSize,
            sort_order: opts.sortOrder ?? fileItemId,
            version,
            created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
            updated_at: Math.floor(Date.now() / 1000),
            ...(opts.stageOnly
                ? {}
                : {
                      dirty: true,
                      localRev,
                  }),
        };

        if (!opts.stageOnly) {
            const { FileService } = await import("./file-service");
            await FileService.createFromUpload(item);
        }

        onProgress({ phase: "done" });
        if (pendingLocalId) {
            // The pipeline is done; the ITEM is not — it sits dirty in IDB until POST /items/batch
            // acknowledges it. Keep the row (phase `syncing`) and the OPFS plaintext staging until
            // then: if the server sweeps the finalized set meanwhile (the orphan window — a tab
            // closed here, a laptop offline for a day), that staging is the only copy left to
            // re-upload from. upload-manager's reconciler deletes both once the item is
            // acknowledged.
            await persistPendingPatch(pendingLocalId, { phase: "syncing", item_id: fileItemId });
            await deleteAllUploadChunks(pendingLocalId);
        } else if (stagingId) {
            await deleteStaging(stagingId);
        }
        return item;
    } catch (e) {
        // After finalize the blob is committed → DELETE /uploads answers 409. Do not lose the resume
        // path: mark orphan_committed so the next start or resume merely re-binds the item, with no
        // re-upload.
        if (pendingLocalId) {
            await persistPendingPatch(pendingLocalId, {
                phase: "orphan_committed",
                last_error: e instanceof Error ? e.message : "commit failed after finalize",
            }).catch(() => {});
        } else {
            // No pending row (e.g. a crop) — best-effort abort; committed → server GC.
            const { abortUpload } = await import("$lib/core/api");
            await abortUpload(chunkSetId).catch(() => {});
        }
        throw e;
    }
}

/**
 * A raster image's thumbnail plus its intrinsic dimensions. The decode happens ONCE —
 * `generateThumbnail` reads `width` and `height` for scaling anyway, so it returns them.
 *
 * Non-images, and images above the thumbnail threshold, return an empty object: the dimensions are
 * optional, and for such files the `encFile` NodeView fills them in itself on the first successful
 * render (a self-heal).
 */
async function prepareImageMeta(
    source: UploadSource,
): Promise<{ thumbnailB64?: string; width?: number; height?: number }> {
    if (!isRasterImageMime(source.mime)) return {};
    if (source.size > 50 * 1024 * 1024) return {};
    const { generateThumbnail } = await import("./thumbnail");
    const file =
        source.kind === "file"
            ? source.file
            : new File(
                  [new Uint8Array(await readPlaintextSlice(source, 0, source.size))],
                  source.name,
                  { type: source.mime },
              );
    const thumb = await generateThumbnail(file);
    if (!thumb) return {};
    return { thumbnailB64: toBase64(thumb.bytes), width: thumb.width, height: thumb.height };
}

/**
 * Starts a new upload (formerly uploadFile with a pending context).
 */
export async function startNewUpload(
    source: UploadSource,
    parentId: string | null,
    opts: UploadOptions = {},
): Promise<LocalItem> {
    // A limit not known yet refuses nothing: the server decides at POST /uploads.
    if (await isOverFileSizeLimit(source.size)) {
        throw new Error(`File too large (max ${getMaxFileSizeMB()} MB)`);
    }
    const onProgress = opts.onProgress ?? (() => {});

    const { thumbnailB64, width: imageWidth, height: imageHeight } = await prepareImageMeta(source);
    const fileItemId = opts.itemId ?? uuidv7();

    // Overwriting the same ID (a backup restore): REUSE the existing Item Key and version.
    // generateItemKeyTask + a parallel tree load (ADD_ITEM_KEY of the old wrap) untie the
    // ciphertext from the stored wrap → a permanent "invalid tag" / the title "Encrypted...".
    const db = await getDB();
    const existing = await db.get("items", fileItemId);
    let encryptedItemKey: number[];
    let itemKeyNonce: number[];
    let version: number;
    let localRev: number;

    if (existing?.type === "file" && existing.encrypted_item_key && existing.item_key_nonce) {
        const ik = fromBase64(existing.encrypted_item_key);
        const ikn = fromBase64(existing.item_key_nonce);
        encryptedItemKey = Array.from(ik);
        itemKeyNonce = Array.from(ikn);
        await addCachedItemKey(fileItemId, ik, ikn);
        version = opts.version ?? existing.version ?? 1;
        localRev = (existing.localRev ?? 0) + 1;
    } else {
        const keys = await generateItemKeyTask(fileItemId);
        encryptedItemKey = keys.encryptedItemKey;
        itemKeyNonce = keys.itemKeyNonce;
        version = opts.version ?? 1;
        localRev = 0;
    }

    const { chunkSize, totalChunks, ciphertextSize, chunkSizes } = chunkPlan({ size: source.size });

    // A new session starts from nothing. Chunks of an earlier session are bound to that session
    // (its chunk set id is in the AAD, and its Item Key may differ), and the stored manifest merges
    // entry by entry — so a leftover would ride into this session on the next resume and give a
    // file whose chunk never decrypts. Every start-over goes through here: a Retry after
    // `failed_expired` and restartFromStaging alike.
    if (opts.pendingLocalId) await deleteAllUploadChunks(opts.pendingLocalId);
    await persistPendingPatch(opts.pendingLocalId, {
        phase: "opening_session",
        chunk_set_id: undefined,
        manifest: {},
        item_id: fileItemId,
        encrypted_item_key: toBase64(new Uint8Array(encryptedItemKey)),
        item_key_nonce: toBase64(new Uint8Array(itemKeyNonce)),
        chunk_size: chunkSize,
        total_chunks: totalChunks,
        ciphertext_size: ciphertextSize,
        chunk_sizes: chunkSizes,
        plain_size: source.size,
    });

    const { chunk_set_id: chunkSetId } = opts.restoreSessionId
        ? await openUploadSession(totalChunks, ciphertextSize, chunkSizes, opts.restoreSessionId)
        : await openUploadSession(totalChunks, ciphertextSize, chunkSizes);

    await persistPendingPatch(opts.pendingLocalId, {
        phase: "uploading",
        chunk_set_id: chunkSetId,
    });

    const manifest = await uploadChunks({
        source,
        itemId: fileItemId,
        chunkSetId,
        totalChunks,
        chunkSize,
        onProgress,
        signal: opts.signal,
        pendingLocalId: opts.pendingLocalId,
        uploadFence: opts.uploadFence,
        abortSessionOnFailure: opts.restoreSessionId !== undefined,
    });

    const stagingId = source.kind === "opfs" ? source.stagingId : undefined;

    return commitUploadedFile({
        source,
        fileItemId,
        chunkSetId,
        manifest,
        chunkSize,
        totalChunks,
        ciphertextSize,
        parentId,
        opts,
        encryptedItemKey,
        itemKeyNonce,
        version,
        localRev,
        thumbnailB64,
        imageWidth,
        imageHeight,
        onProgress,
        pendingLocalId: opts.pendingLocalId,
        stagingId,
    });
}

/**
 * Resumes an upload from the pending-uploads queue.
 * It does not call openUpload when chunk_set_id exists and the session is uploading.
 */
export async function resumeUpload(
    pending: PendingUpload,
    opts: UploadOptions = {},
): Promise<LocalItem> {
    const normalized = normalizePending(pending);
    const source = uploadSourceFromPending(normalized);

    if (!source) {
        throw new UploadPipelineError(
            "Cannot resume upload without local file data",
            "fatal_integrity",
            "failed_expired",
        );
    }

    const parentId = normalized.parent_id;
    const pendingLocalId = normalized.local_id;
    const mergedOpts: UploadOptions = { ...opts, pendingLocalId };
    const stagingId = normalized.staging_id;

    if (!normalized.chunk_set_id) {
        return startNewUpload(source, parentId, mergedOpts);
    }

    if (normalized.phase === "orphan_committed") await waitForOwnerNote(normalized);

    const chunkSetId = normalized.chunk_set_id;
    const fileItemId = normalized.item_id ?? opts.itemId ?? uuidv7();
    const { chunkSize, totalChunks, ciphertextSize } =
        normalized.chunk_size && normalized.total_chunks
            ? {
                  chunkSize: normalized.chunk_size,
                  totalChunks: normalized.total_chunks,
                  ciphertextSize: normalized.ciphertext_size ?? source.size,
              }
            : chunkPlan({ size: source.size });

    let status: Awaited<ReturnType<typeof getUploadStatus>>;
    try {
        status = await getUploadStatus(chunkSetId);
    } catch (err) {
        const errorClass = classifyUploadError(err);
        if (errorClass === "fatal_session") {
            await persistPendingPatch(pendingLocalId, { phase: "failed_expired" });
            throw new UploadPipelineError(
                err instanceof Error ? err.message : "Upload session expired",
                errorClass,
                "failed_expired",
            );
        }
        throw err;
    }

    if (status.session_status === "aborted") {
        await persistPendingPatch(pendingLocalId, { phase: "failed_expired" });
        throw new UploadPipelineError("Upload session aborted", "fatal_session", "failed_expired");
    }

    // The server swept the finalized blob (the orphan sweep, or a deep-repair ghost row): the
    // session says `purged`, or it still says `committed` while its objects are gone. Binding an
    // item to those bytes would fail on every push forever, and the commit path would delete the
    // local staging — the ONLY copy left. Start over with a fresh session from that staging
    // instead.
    if (
        status.session_status === "purged" ||
        (status.session_status === "committed" &&
            !allChunksPresentOnS3(status.present_indices, totalChunks))
    ) {
        // Not while the owner note is in the Trash: the upload would only wait again after it.
        await waitForOwnerNote(normalized);
        return restartFromStaging(normalized, source, parentId, {
            ...mergedOpts,
            ...(normalized.item_id ? { itemId: normalized.item_id } : {}),
        });
    }

    const reconcile = await reconcileManifestWithStatus(
        pendingLocalId,
        normalized.manifest ?? {},
        status.present_indices,
    );
    if (reconcile.fatalIntegrity) {
        await persistPendingPatch(pendingLocalId, { phase: "failed_expired" });
        throw new UploadPipelineError(
            "S3 chunk without local ciphertext",
            "fatal_integrity",
            "failed_expired",
        );
    }
    const manifest = reconcile.manifest;
    const confirmedIndices = reconcile.confirmedIndices;
    await persistPendingPatch(pendingLocalId, { phase: "uploading", manifest });

    const onProgress = opts.onProgress ?? (() => {});

    let encryptedItemKey: number[];
    let itemKeyNonce: number[];
    if (normalized.encrypted_item_key && normalized.item_key_nonce) {
        const ik = fromBase64(normalized.encrypted_item_key);
        const ikn = fromBase64(normalized.item_key_nonce);
        encryptedItemKey = Array.from(ik);
        itemKeyNonce = Array.from(ikn);
        const { addCachedItemKey } = await import("$lib/core/workers/crypto-rpc");
        await addCachedItemKey(fileItemId, ik, ikn);
    } else {
        const keys = await generateItemKeyTask(fileItemId);
        encryptedItemKey = keys.encryptedItemKey;
        itemKeyNonce = keys.itemKeyNonce;
    }

    const { thumbnailB64, width: imageWidth, height: imageHeight } = await prepareImageMeta(source);

    const db = await getDB();
    const existingItem = fileItemId ? await db.get("items", fileItemId) : undefined;
    if (existingItem?.type === "file") {
        // The item was committed locally by an earlier run — the same `syncing` contract as
        // commitUploadedFile: the staging lives until the item's push is acknowledged.
        await deleteAllUploadChunks(pendingLocalId);
        await persistPendingPatch(pendingLocalId, { phase: "syncing", item_id: existingItem.id });
        return existingItem;
    }

    if (
        status.session_status === "uploading" &&
        allChunksPresentOnS3(status.present_indices, totalChunks)
    ) {
        onProgress({ phase: "finalizing" });
        await persistPendingPatch(pendingLocalId, { phase: "finalizing" });
        await finalizeUpload(chunkSetId);
        status = { ...status, session_status: "committed" };
    }

    if (status.session_status === "committed") {
        const manifestArray: ChunkRef[] = [];
        for (let i = 0; i < totalChunks; i++) {
            const entry = manifest[i];
            if (entry) manifestArray.push(entry);
        }
        await persistPendingPatch(pendingLocalId, { phase: "orphan_committed" });
        return commitUploadedFile({
            source,
            fileItemId,
            chunkSetId,
            manifest: manifestArray,
            chunkSize,
            totalChunks,
            ciphertextSize,
            parentId,
            opts: mergedOpts,
            encryptedItemKey,
            itemKeyNonce,
            version: mergedOpts.version ?? 1,
            localRev: 0,
            thumbnailB64,
            imageWidth,
            imageHeight,
            onProgress,
            pendingLocalId,
            stagingId,
        });
    }

    const firstUnconfirmed = Array.from({ length: totalChunks }, (_, i) => i).find(
        (i) => !confirmedIndices.has(i),
    );
    const startIndex = firstUnconfirmed ?? totalChunks;

    const uploadedManifest = await uploadChunks({
        source,
        itemId: fileItemId,
        chunkSetId,
        totalChunks,
        chunkSize,
        onProgress,
        signal: opts.signal,
        pendingLocalId,
        uploadFence: mergedOpts.uploadFence,
        startIndex,
        confirmedIndices,
        existingManifest: manifest,
    });

    return commitUploadedFile({
        source,
        fileItemId,
        chunkSetId,
        manifest: uploadedManifest,
        chunkSize,
        totalChunks,
        ciphertextSize,
        parentId,
        opts: mergedOpts,
        encryptedItemKey,
        itemKeyNonce,
        version: mergedOpts.version ?? 1,
        localRev: 0,
        thumbnailB64,
        imageWidth,
        imageHeight,
        onProgress,
        pendingLocalId,
        stagingId,
    });
}

/**
 * A committed set waits for its owner note. In the Trash → the row stays `orphan_committed` and
 * nothing more happens: no status call, no second upload. Gone for good → the row and its staging
 * are released (the set is committed; the GC collects it). Both throw, so the pipeline stops here;
 * a note that is back lets it carry on.
 */
async function waitForOwnerNote(pending: PendingUpload): Promise<void> {
    const owner = await ownerNoteState(pending);
    if (owner === "ready") return;
    if (owner === "gone") {
        await cleanupLocalPendingRow(pending);
        throw new UploadPipelineError("Owner note was deleted", "fatal_session", "failed_expired");
    }
    await persistPendingPatch(pending.local_id, {
        phase: "orphan_committed",
        last_error: "Owner note is in the Trash",
    });
    throw new UploadPipelineError("Owner note is in the Trash", "fatal_session", "failed_expired");
}

/**
 * The uploaded bytes are gone from the server, the local plaintext staging is still here: forget the
 * dead session (chunk set, manifest, staged ciphertext) and run the pipeline again from the source.
 * The pending row keeps its identity (local_id, note_id, parent_id), so the editor's `local:` node
 * and the multi-tab fence stay valid.
 */
async function restartFromStaging(
    pending: PendingUpload,
    source: UploadSource,
    parentId: string | null,
    opts: UploadOptions,
): Promise<LocalItem> {
    // startNewUpload drops the dead session's chunk set, manifest and staged ciphertext itself.
    await persistPendingPatch(pending.local_id, {
        last_error: "The server no longer has this upload — uploading it again",
    });
    return startNewUpload(source, parentId, opts);
}

/**
 * Uploads one file as an encrypted `type:"file"` item. Returns the created LocalItem.
 * A compatibility wrapper around startNewUpload.
 */
export async function uploadFile(
    file: File,
    parentId: string | null,
    opts: UploadOptions = {},
): Promise<LocalItem> {
    return startNewUpload(uploadSourceFromFile(file), parentId, opts);
}

/**
 * Replaces an existing file item's content. It uploads the new bytes into a COMPLETELY NEW chunk
 * set — the old one is never mutated in place, so stale clients keep reading it — reuses the file's
 * existing Item Key, then atomically switches the item payload's `chunkSetId` and manifest and
 * bumps the version through the normal mutation queue. The orphaned old set is reclaimed by GC
 * after the grace window; it is not deleted here.
 */
export async function replaceFileContent(
    itemId: string,
    fileOrSource: File | UploadSource,
    opts: UploadOptions = {},
): Promise<LocalItem> {
    // A File from the crop dialog, or an OPFS staging source (the re-upload of an item whose
    // finalized set the server swept before the item reached it — upload-manager's reconciler).
    const source = fileOrSource instanceof File ? uploadSourceFromFile(fileOrSource) : fileOrSource;
    // A limit not known yet refuses nothing: the server decides at POST /uploads.
    if (await isOverFileSizeLimit(source.size)) {
        throw new Error(`File too large (max ${getMaxFileSizeMB()} MB)`);
    }
    const onProgress = opts.onProgress ?? (() => {});

    const db = await getDB();
    const existing = await db.get("items", itemId);
    if (existing?.type !== "file") throw new Error("File not found");
    const oldChunkSetId = existing.chunk_set_id;

    const { addCachedItemKey, decryptPayloadTask } = await import("$lib/core/workers/crypto-rpc");
    await addCachedItemKey(
        itemId,
        fromBase64(existing.encrypted_item_key || ""),
        fromBase64(existing.item_key_nonce || ""),
    );

    const { thumbnailB64, width: imageWidth, height: imageHeight } = await prepareImageMeta(source);

    const { chunkSize, totalChunks, ciphertextSize, chunkSizes } = chunkPlan({ size: source.size });
    const { chunk_set_id: newChunkSetId, put_urls: putUrls } = await openUpload(
        totalChunks,
        ciphertextSize,
        chunkSizes,
    );
    const manifest = await uploadChunks({
        source,
        itemId,
        chunkSetId: newChunkSetId,
        putUrls,
        totalChunks,
        chunkSize,
        onProgress,
        signal: opts.signal,
    });

    try {
        onProgress({ phase: "committing" });
        // A re-read + re-decrypt BEFORE the encryption: the upload took time, and in that window a
        // rename/move or a pull could have changed the payload or metadata. The old snapshot from the
        // top of the function would silently overwrite the name/description/parent (not merely cause a 409).
        const buildCropPayload = async (
            baseItem: LocalItem,
        ): Promise<{ payload: Record<string, unknown>; localRev: number; version: number }> => {
            const current = await decryptPayloadTask<Record<string, unknown>>(
                itemId,
                fromBase64(baseItem.encrypted_payload || ""),
                fromBase64(baseItem.payload_nonce || ""),
                baseItem.version ?? 1,
            );
            const payload: Record<string, unknown> = {
                ...current,
                kind: "file",
                chunkSetId: newChunkSetId,
                mime: source.mime || "application/octet-stream",
                size: source.size,
                chunkSize,
                chunks: manifest,
            };
            if (thumbnailB64) {
                payload.thumbnail = thumbnailB64;
            } else {
                delete payload.thumbnail;
            }
            // A crop changes the intrinsic dimensions — the old ones would reserve the wrong space.
            // If the new ones are unknown (a non-image, or above the threshold), clear them.
            if (imageWidth && imageHeight) {
                payload.width = imageWidth;
                payload.height = imageHeight;
            } else {
                delete payload.width;
                delete payload.height;
            }
            return {
                payload,
                localRev: baseItem.localRev ?? 0,
                version: baseItem.version ?? 1,
            };
        };

        const freshItem = await db.get("items", itemId);
        if (!freshItem || freshItem.type !== "file") {
            throw new Error("File disappeared during upload");
        }
        if (freshItem.purged_at) {
            throw new Error("File was permanently deleted during replace");
        }

        let built = await buildCropPayload(freshItem);
        let { ciphertext, nonce } = await encryptPayloadTask(itemId, built.payload, built.version);

        // A CAS: a concurrent reencrypt (a rename) during the crypto await — one retry with the latest.
        let commitItem = await db.get("items", itemId);
        if (!commitItem || commitItem.type !== "file") {
            throw new Error("File disappeared during upload");
        }
        if ((commitItem.localRev ?? 0) !== built.localRev) {
            if (commitItem.purged_at) {
                throw new Error("File was permanently deleted during replace");
            }
            built = await buildCropPayload(commitItem);
            ({ ciphertext, nonce } = await encryptPayloadTask(
                itemId,
                built.payload,
                built.version,
            ));
            commitItem = await db.get("items", itemId);
            if (!commitItem || commitItem.type !== "file") {
                throw new Error("File disappeared during upload");
            }
            // If the second attempt also races a newer localRev, we still write the blob merge onto
            // the latest row (parent_id and deleted_at from commitItem), not onto the stale existing
            // one from the start.
        }

        commitItem.encrypted_payload = toBase64(new Uint8Array(ciphertext));
        commitItem.payload_nonce = toBase64(new Uint8Array(nonce));
        commitItem.chunk_set_id = newChunkSetId;
        commitItem.chunk_count = totalChunks;
        commitItem.ciphertext_size = ciphertextSize;
        commitItem.dirty = true;
        commitItem.localRev = (commitItem.localRev ?? 0) + 1;
        commitItem.updated_at = Math.floor(Date.now() / 1000);

        await db.put("items", commitItem);
        // Awaited rather than fire-and-forget: we need a confirmed dirty state before deciding
        // whether it is safe to evict the old chunk set (see below). _pushItemImpl swallows errors
        // internally and
        // re-enqueues instead of throwing, so the catch here is defensive (a mutex chain rejection).
        await pushItem(commitItem).catch(() => enqueueMutation(commitItem.id, "upsert"));

        if (oldChunkSetId && oldChunkSetId !== newChunkSetId) {
            // Evict the old set's local cache ONLY when the push is genuinely confirmed
            // (dirty:false) — otherwise the server still references the old set (it was never
            // "released") and we would locally delete the only offline-available source of that file
            // until the retry succeeds.
            const confirmed = await db.get("items", itemId);
            if (confirmed && !confirmed.dirty) {
                void evictChunkSet(oldChunkSetId).catch(() => {});
            }
        }

        onProgress({ phase: "done" });
        return commitItem;
    } catch (e) {
        // Crop and replace have no resume path — on any failure (network or a user abort), release
        // the session and the reserved quota; otherwise it lies around until the GC stale TTL.
        const { abortUpload } = await import("$lib/core/api");
        await abortUpload(newChunkSetId).catch(() => {});
        throw e;
    }
}
