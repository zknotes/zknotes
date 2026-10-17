// Integration tests for the V3 presigned upload flow against a real test Garage (S3-compatible):
//   POST /uploads               → 201 { chunk_set_id }, the quota reserved at open
//   POST /uploads/:id/urls      → lazily mints the presigned PUT URLs
//   PUT <put_url>               → the client sends a chunk straight to S3/Garage (fetch, not app.inject)
//   POST /uploads/:id/finalize  → a 1:1:1 ListObjectsV2 validation, writes chunk_sets + file_chunks
//   DELETE /uploads/:id         → abort: frees the quota synchronously and deletes the S3 objects
//   HEAD/GET /uploads/:id/chunks/:index → existence check / presigned GET URL

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { buildApp } from "../../src/app";
import { db } from "../../src/db";
import { users } from "../../src/db/schema";
import { S3_BUCKET, s3 } from "../../src/s3";
import {
    countChunkSets,
    countFileChunks,
    createTestUser,
    filePayload,
    getChunkSet,
    getUploadSessionStatus,
    getUserIdByEmail,
    getUserStorageUsed,
    insertChunkSet,
    insertLiveItem,
    resetDb,
    setUserStorage,
} from "../helpers";

const CHUNK_BODY = Buffer.allocUnsafe(64).fill(0xab);

let app: FastifyInstance;
let cookie: string;
let userEmail: string;

beforeAll(async () => {
    app = await buildApp();
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    await resetDb();
    ({ cookie, email: userEmail } = await createTestUser(app));
});

// ── Local helpers ────────────────────────────────────────────────────────────

type OpenUploadBody = { chunk_set_id: string };
type MintUrlsBody = { urls: { index: number; put_url: string }[] };

/** Compute the default per-chunk sizes when the caller does not give them explicitly. */
function defaultChunkSizes(totalSize: number, chunks: number): number[] {
    if (chunks === 1) return [totalSize];
    const base = Math.floor(totalSize / chunks);
    const last = totalSize - base * (chunks - 1);
    return [...Array(chunks - 1).fill(base), last];
}

async function openUpload(
    opts: { chunks?: number; totalSize?: number; as?: string; chunkSizes?: number[] } = {},
) {
    const chunks = opts.chunks ?? 1;
    const totalSize = opts.totalSize ?? CHUNK_BODY.length;
    const chunkSizes = opts.chunkSizes ?? defaultChunkSizes(totalSize, chunks);
    return app.inject({
        method: "POST",
        url: "/uploads",
        headers: { cookie: opts.as ?? cookie },
        payload: {
            expected_chunks: chunks,
            total_size: totalSize,
            chunk_sizes: chunkSizes,
        },
    });
}

/** Lazily mints presigned PUT URLs in batches of 32. */
async function mintPutUrls(chunkSetId: string, chunkCount: number, as = cookie): Promise<string[]> {
    const put_urls: string[] = [];
    const BATCH = 32;
    for (let start = 0; start < chunkCount; start += BATCH) {
        const indices = Array.from(
            { length: Math.min(BATCH, chunkCount - start) },
            (_, i) => start + i,
        );
        const res = await app.inject({
            method: "POST",
            url: `/uploads/${chunkSetId}/urls`,
            headers: { cookie: as },
            payload: { indices },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as MintUrlsBody;
        for (const { index, put_url } of body.urls) {
            put_urls[index] = put_url;
        }
    }
    return put_urls;
}

/** PUTs a chunk straight to the test Garage through a presigned URL — the real V3 upload path. */
async function putChunkS3(putUrl: string, body: Buffer = CHUNK_BODY): Promise<Response> {
    return fetch(putUrl, { method: "PUT", body });
}

async function finalize(chunkSetId: string, as = cookie) {
    return app.inject({
        method: "POST",
        url: `/uploads/${chunkSetId}/finalize`,
        headers: { cookie: as },
    });
}

async function abort(chunkSetId: string, as = cookie) {
    return app.inject({
        method: "DELETE",
        url: `/uploads/${chunkSetId}`,
        headers: { cookie: as },
    });
}

async function headChunk(chunkSetId: string, index: number, as = cookie) {
    return app.inject({
        method: "HEAD",
        url: `/uploads/${chunkSetId}/chunks/${index}`,
        headers: { cookie: as },
    });
}

/** Open → presigned PUT of every chunk to Garage → finalize. Returns the chunk_set_id. */
async function fullUpload(chunks: Buffer[]): Promise<string> {
    const totalSize = chunks.reduce((s, c) => s + c.length, 0);
    const chunkSizes = chunks.map((c) => c.length);
    const openRes = await openUpload({ chunks: chunks.length, totalSize, chunkSizes });
    expect(openRes.statusCode).toBe(201);
    const { chunk_set_id } = openRes.json() as OpenUploadBody;
    const put_urls = await mintPutUrls(chunk_set_id, chunks.length);
    expect(put_urls).toHaveLength(chunks.length);

    for (let i = 0; i < chunks.length; i++) {
        const r = await putChunkS3(put_urls[i]!, chunks[i]!);
        expect(r.status).toBe(200);
    }

    const finalRes = await finalize(chunk_set_id);
    expect(finalRes.statusCode).toBe(200);
    return chunk_set_id;
}

// ── GET /me/storage ───────────────────────────────────────────────────────────

describe("GET /me/storage", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({ method: "GET", url: "/me/storage" });
        expect(res.statusCode).toBe(401);
    });

    test("a new user → used=0, the quota from the permissive provider, and no plan", async () => {
        const res = await app.inject({ method: "GET", url: "/me/storage", headers: { cookie } });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.breakdown.total_used).toBe(0);
        // The open-core quota comes from the permissive provider (seam 2, `SELF_HOST_STORAGE_QUOTA`,
        // 100 GB by default), not from `PLAN_LIMITS.free` — the core does not know about plans.
        expect(body.storage_quota).toBe(100 * 1024 * 1024 * 1024);
        // The raw plan key deliberately **no longer leaves** the API: the vault may see only the
        // plan label and whether it is paid, not a taxonomy of plans.
        // The vault gets the plan label and the concrete TTL limit — not the raw plan key, nor
        // `is_paid_plan`.
        expect(body.plan).toBeUndefined();
        expect(body.is_paid_plan).toBeUndefined();
        // A self-host has no plan, so the UI does not render the line carrying its name.
        expect(body.plan_label).toBeNull();
        expect(typeof body.max_share_ttl_sec).toBe("number");
    });

    test("after a committed upload plus a created item → used reflects the chunk set size", async () => {
        // V3: the quota counts only chunk sets bound to a READY item.
        // An upload on its own does not count towards the quota — an item has to be created.
        const chunkSetId = await fullUpload([CHUNK_BODY]);

        // Create a file item referencing the uploaded chunk set
        const itemRes = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(uuidv7(), chunkSetId),
        });
        expect(itemRes.statusCode).toBe(201);

        const res = await app.inject({ method: "GET", url: "/me/storage", headers: { cookie } });
        expect(res.json().breakdown.files_bytes).toBe(CHUNK_BODY.length);
    });

    test("an in-progress upload session counts towards used (reserved at open)", async () => {
        await openUpload();

        const res = await app.inject({ method: "GET", url: "/me/storage", headers: { cookie } });
        expect(res.json().breakdown.files_bytes).toBe(CHUNK_BODY.length);
    });

    test("storage over 2^31 bytes does not cause a 500 (the ::bigint fix)", async () => {
        // Users with a raised quota can pass 2 GB; SUM(bigint)::integer would overflow.
        const BIG = 2 ** 31 + 100; // 2,147,483,748 — above INT32_MAX
        const userId = await getUserIdByEmail(userEmail);
        if (!userId) throw new Error("test user not found");

        const csId = uuidv7();
        await insertChunkSet(csId, userId, { totalSize: BIG });
        const itemId = uuidv7();
        await insertLiveItem(itemId, userId, csId);

        // We update the users table because GET /me/storage now reads the storage_used_files column
        await db.update(users).set({ storage_used_files: BIG }).where(eq(users.id, userId));

        const res = await app.inject({ method: "GET", url: "/me/storage", headers: { cookie } });
        expect(res.statusCode).toBe(200);
        expect(res.json().breakdown.files_bytes).toBe(BIG);
    });
});

// ── POST /uploads ─────────────────────────────────────────────────────────────

describe("POST /uploads", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/uploads",
            payload: { expected_chunks: 1, total_size: 100 },
        });
        expect(res.statusCode).toBe(401);
    });

    test("a valid payload → 201 with a chunk_set_id UUID (no bulk put_urls)", async () => {
        const res = await openUpload({ chunks: 2, totalSize: 128 });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OpenUploadBody;
        expect(body.chunk_set_id).toBeString();
        expect(body.chunk_set_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect("put_urls" in (res.json() as object)).toBe(false);
    });

    test("open reserves the quota up front — storage_used_files = total_size", async () => {
        const res = await openUpload({ totalSize: 500 });
        expect(res.statusCode).toBe(201);

        expect(await getUserStorageUsed(userEmail)).toBe(500);
    });

    test("missing fields → 400", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/uploads",
            headers: { cookie },
            payload: { expected_chunks: 1 },
        });
        expect(res.statusCode).toBe(400);
    });

    test("total_size exceeds the user's quota → 413", async () => {
        await setUserStorage(userEmail, 100);

        const res = await openUpload({ chunks: 1, totalSize: 200 });
        expect(res.statusCode).toBe(413);
        expect(res.json().error).toBe("quota_exceeded");
        expect(res.json().quota).toBe(100);
    });

    test("a 413 does not change storage_used_files (the reservation is atomic)", async () => {
        await setUserStorage(userEmail, 100, 50);

        const res = await openUpload({ chunks: 1, totalSize: 200 });
        expect(res.statusCode).toBe(413);
        expect(await getUserStorageUsed(userEmail)).toBe(50);
    });

    test("too many concurrent sessions → 429", async () => {
        for (let i = 0; i < 5; i++) {
            const r = await openUpload();
            expect(r.statusCode).toBe(201);
        }
        const res = await openUpload();
        expect(res.statusCode).toBe(429);
        expect(res.json().error).toBe("too_many_uploads");
    });

    test("expected_chunks = 0 → 400", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/uploads",
            headers: { cookie },
            payload: { expected_chunks: 0, total_size: 100 },
        });
        expect(res.statusCode).toBe(400);
    });
});

// ── Lazy mint, ping, batch status ────────────────────────────────────────────

describe("POST /uploads/:chunkSetId/urls", () => {
    test("mint returns presigned URLs for the requested indices", async () => {
        const openRes = await openUpload({ chunks: 3, totalSize: CHUNK_BODY.length * 3 });
        const { chunk_set_id } = openRes.json() as OpenUploadBody;

        const res = await app.inject({
            method: "POST",
            url: `/uploads/${chunk_set_id}/urls`,
            headers: { cookie },
            payload: { indices: [0, 2] },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as MintUrlsBody;
        expect(body.urls).toHaveLength(2);
        for (const u of body.urls) {
            expect(u.put_url).toContain("X-Amz-Signature=");
        }
    });

    test("duplicate indices → 400", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const res = await app.inject({
            method: "POST",
            url: `/uploads/${chunk_set_id}/urls`,
            headers: { cookie },
            payload: { indices: [0, 0] },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("duplicate_indices");
    });

    test("an index out of range → 400", async () => {
        const openRes = await openUpload({ chunks: 2, totalSize: 128 });
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const res = await app.inject({
            method: "POST",
            url: `/uploads/${chunk_set_id}/urls`,
            headers: { cookie },
            payload: { indices: [2] },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("bad_chunk_index");
    });
});

describe("POST /uploads/:chunkSetId/ping", () => {
    test("an uploading session → 200 and updated_at is refreshed", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const res = await app.inject({
            method: "POST",
            url: `/uploads/${chunk_set_id}/ping`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().session_status).toBe("uploading");
    });
});

describe("GET /uploads/:chunkSetId/status", () => {
    test("returns present_indices after a partial upload", async () => {
        const openRes = await openUpload({ chunks: 2, totalSize: CHUNK_BODY.length * 2 });
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const put_urls = await mintPutUrls(chunk_set_id, 2);
        await putChunkS3(put_urls[0]!);

        const res = await app.inject({
            method: "GET",
            url: `/uploads/${chunk_set_id}/status`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
            session_status: string;
            present_indices: number[];
            total_present_size: number;
        };
        expect(body.session_status).toBe("uploading");
        expect(body.present_indices).toEqual([0]);
        expect(body.total_present_size).toBe(CHUNK_BODY.length);
    });
});

// ── Presigned PUT + HEAD /uploads/:chunkSetId/chunks/:index ───────────────────

describe("Presigned PUT to S3 plus a HEAD existence check", () => {
    test("a PUT to the presigned URL → 200, and HEAD confirms the object", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const put_urls = await mintPutUrls(chunk_set_id, 1);

        expect((await headChunk(chunk_set_id, 0)).statusCode).toBe(404);

        const r = await putChunkS3(put_urls[0]!);
        expect(r.status).toBe(200);

        expect((await headChunk(chunk_set_id, 0)).statusCode).toBe(200);
    });

    test("re-PUTting the same chunk (retry/resume) → 200, idempotent", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const put_urls = await mintPutUrls(chunk_set_id, 1);

        expect((await putChunkS3(put_urls[0]!)).status).toBe(200);
        expect((await putChunkS3(put_urls[0]!)).status).toBe(200);

        // Still exactly one object → finalize goes through
        const finalRes = await finalize(chunk_set_id);
        expect(finalRes.statusCode).toBe(200);
    });

    test("HEAD without a session → 401", async () => {
        const res = await app.inject({ method: "HEAD", url: `/uploads/${uuidv7()}/chunks/0` });
        expect(res.statusCode).toBe(401);
    });

    test("HEAD of a nonexistent chunk set → 404", async () => {
        const res = await headChunk(uuidv7(), 0);
        expect(res.statusCode).toBe(404);
    });

    test("HEAD of another user's session → 404 (user isolation)", async () => {
        const chunkSetId = await fullUpload([CHUNK_BODY]);
        const { cookie: otherCookie } = await createTestUser(app, { email: "other@example.com" });

        const res = await headChunk(chunkSetId, 0, otherCookie);
        expect(res.statusCode).toBe(404);
    });
});

// ── POST /uploads/:chunkSetId/finalize ────────────────────────────────────────

describe("POST /uploads/:chunkSetId/finalize", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({ method: "POST", url: "/uploads/fakeid/finalize" });
        expect(res.statusCode).toBe(401);
    });

    test("a nonexistent session → 404", async () => {
        const res = await finalize(uuidv7());
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe("no_session");
    });

    test("the wrong number of chunks → 409", async () => {
        const openRes = await openUpload({ chunks: 2, totalSize: CHUNK_BODY.length * 2 });
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const put_urls = await mintPutUrls(chunk_set_id, 2);
        await putChunkS3(put_urls[0]!);

        const res = await finalize(chunk_set_id);
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("incomplete");
        expect(res.json().detail.expected_chunks).toBe(2);
        expect(res.json().detail.got_chunks).toBe(1);
    });

    test("the wrong total size → S3 refuses the PUT, or finalize returns 409", async () => {
        // The URL is signed with ContentLength: 1000; a PUT sending 64B → Garage refuses.
        const openRes = await openUpload({ chunks: 1, totalSize: 1000 });
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const put_urls = await mintPutUrls(chunk_set_id, 1);
        const putRes = await putChunkS3(put_urls[0]!); // 64 bytes, 1000 declared

        if (!putRes.ok) {
            // At the S3 level: a presigned ContentLength mismatch → rejected before finalize.
            expect([400, 403]).toContain(putRes.status);
            // Finalize sees 0 uploaded chunks → 409.
            const res = await finalize(chunk_set_id);
            expect(res.statusCode).toBe(409);
            expect(res.json().detail.got_size).toBe(0);
        } else {
            // S3 did not enforce ContentLength → finalize catches the size mismatch.
            const res = await finalize(chunk_set_id);
            expect(res.statusCode).toBe(409);
            expect(res.json().error).toBe("incomplete");
            expect(res.json().detail.expected_size).toBe(1000);
            expect(res.json().detail.got_size).toBe(CHUNK_BODY.length);
        }
    });

    test("a valid finalize → 200, the session committed, chunk_sets + file_chunks written", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const put_urls = await mintPutUrls(chunk_set_id, 1);
        await putChunkS3(put_urls[0]!);

        const res = await finalize(chunk_set_id);
        expect(res.statusCode).toBe(200);
        expect(res.json().ok).toBe(true);

        expect(await getUploadSessionStatus(chunk_set_id)).toBe("committed");

        const cs = await getChunkSet(chunk_set_id);
        expect(cs?.total_size).toBe(CHUNK_BODY.length);
        expect(cs?.chunk_count).toBe(1);

        // V3: finalize fills file_chunks from the real S3 objects (ListObjectsV2)
        expect(await countFileChunks(chunk_set_id)).toBe(1);
    });

    test("finalize with 1001 chunks — ListObjectsV2 pagination (regression)", async () => {
        const CHUNKS = 1001;
        const chunkSize = 16;
        const totalSize = CHUNKS * chunkSize;
        const chunkSizes = Array<number>(CHUNKS).fill(chunkSize);
        const openRes = await openUpload({ chunks: CHUNKS, totalSize, chunkSizes });
        expect(openRes.statusCode).toBe(201);
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const userId = await getUserIdByEmail(userEmail);

        for (let i = 0; i < CHUNKS; i++) {
            await s3.send(
                new PutObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: `u/${userId}/${chunk_set_id}/${i}`,
                    Body: Buffer.alloc(chunkSize),
                }),
            );
        }

        const res = await finalize(chunk_set_id);
        expect(res.statusCode).toBe(200);
        expect(await getUploadSessionStatus(chunk_set_id)).toBe("committed");
        expect(await countFileChunks(chunk_set_id)).toBe(CHUNKS);
    }, 60_000);

    test("several chunks → finalization passes with the exact total size", async () => {
        const c1 = Buffer.allocUnsafe(32).fill(0x01);
        const c2 = Buffer.allocUnsafe(48).fill(0x02);
        const chunkSetId = await fullUpload([c1, c2]);

        const cs = await getChunkSet(chunkSetId);
        expect(cs?.total_size).toBe(80);
        expect(cs?.chunk_count).toBe(2);
        expect(await countFileChunks(chunkSetId)).toBe(2);
    });

    test("already committed (idempotent) → 200", async () => {
        const chunkSetId = await fullUpload([CHUNK_BODY]);

        const res = await finalize(chunkSetId);
        expect(res.statusCode).toBe(200);
    });

    test("finalizing an aborted session → 409", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        await abort(chunk_set_id);

        const res = await finalize(chunk_set_id);
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("incomplete");
    });
});

// ── DELETE /uploads/:chunkSetId ───────────────────────────────────────────────

describe("DELETE /uploads/:chunkSetId", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({ method: "DELETE", url: "/uploads/fakeid" });
        expect(res.statusCode).toBe(401);
    });

    test("a nonexistent session → 404", async () => {
        const res = await abort(uuidv7());
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe("no_session");
    });

    test("a committed session cannot be aborted → 409", async () => {
        const chunkSetId = await fullUpload([CHUNK_BODY]);
        const res = await abort(chunkSetId);
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe("already_committed");
    });

    test("a valid abort → 200, the session aborted", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;

        const res = await abort(chunk_set_id);
        expect(res.statusCode).toBe(200);
        expect(await getUploadSessionStatus(chunk_set_id)).toBe("aborted");
    });

    test("abort returns the reserved quota synchronously — storage_used_files drops back to 0", async () => {
        // The user does not wait for a TTL job; the quota is free at once
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;

        expect(await getUserStorageUsed(userEmail)).toBe(CHUNK_BODY.length);

        await abort(chunk_set_id);

        expect(await getUserStorageUsed(userEmail)).toBe(0);
    });

    test("abort deletes the uploaded S3 objects", async () => {
        const openRes = await openUpload({ chunks: 2, totalSize: CHUNK_BODY.length * 2 });
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const put_urls = await mintPutUrls(chunk_set_id, 2);
        await putChunkS3(put_urls[0]!);
        await putChunkS3(put_urls[1]!);
        expect((await headChunk(chunk_set_id, 0)).statusCode).toBe(200);

        await abort(chunk_set_id);

        expect((await headChunk(chunk_set_id, 0)).statusCode).toBe(404);
        expect((await headChunk(chunk_set_id, 1)).statusCode).toBe(404);
    });

    test("idempotent: aborting an already-aborted session → 200", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        await abort(chunk_set_id);

        const res = await abort(chunk_set_id);
        expect(res.statusCode).toBe(200);
    });

    test("parallel abort does not double-free quota", async () => {
        await setUserStorage(userEmail, 10_000_000, 1000);
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        expect(await getUserStorageUsed(userEmail)).toBe(1000 + CHUNK_BODY.length);

        const results = await Promise.all([abort(chunk_set_id), abort(chunk_set_id)]);
        expect(results.every((r) => r.statusCode === 200)).toBe(true);
        expect(await getUserStorageUsed(userEmail)).toBe(1000);
    });
});

// ── GET /uploads/:chunkSetId/chunks/:index ────────────────────────────────────

describe("GET /uploads/:chunkSetId/chunks/:index", () => {
    test("without a session → 401", async () => {
        const res = await app.inject({ method: "GET", url: "/uploads/fakeid/chunks/0" });
        expect(res.statusCode).toBe(401);
    });

    test("an invalid UUID format for chunk_set_id → 400", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/uploads/not-a-uuid/chunks/0",
            headers: { cookie },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("bad_chunk_set_id");
    });

    test("a negative chunk index → 400", async () => {
        const chunkSetId = await fullUpload([CHUNK_BODY]);
        const res = await app.inject({
            method: "GET",
            url: `/uploads/${chunkSetId}/chunks/-1`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe("bad_chunk_index");
    });

    test("a non-existent chunk set → 404", async () => {
        const res = await app.inject({
            method: "GET",
            url: `/uploads/${uuidv7()}/chunks/0`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(404);
    });

    test("downloading a chunk from a committed set → the presigned URL returns the original bytes", async () => {
        const chunkSetId = await fullUpload([CHUNK_BODY]);

        const res = await app.inject({
            method: "GET",
            url: `/uploads/${chunkSetId}/chunks/0`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
        const { url } = res.json() as { url: string };
        expect(url).toContain("X-Amz-Signature=");

        const s3Res = await fetch(url);
        expect(s3Res.status).toBe(200);
        expect(Buffer.from(await s3Res.arrayBuffer())).toEqual(CHUNK_BODY);
    });

    test("downloading a chunk from an in-progress session → the presigned URL works", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const put_urls = await mintPutUrls(chunk_set_id, 1);
        await putChunkS3(put_urls[0]!);

        const res = await app.inject({
            method: "GET",
            url: `/uploads/${chunk_set_id}/chunks/0`,
            headers: { cookie },
        });
        expect(res.statusCode).toBe(200);

        const s3Res = await fetch((res.json() as { url: string }).url);
        expect(s3Res.status).toBe(200);
        expect(Buffer.from(await s3Res.arrayBuffer())).toEqual(CHUNK_BODY);
    });

    test("another user's chunk set → 404 (user isolation)", async () => {
        const chunkSetId = await fullUpload([CHUNK_BODY]);
        const { cookie: otherCookie } = await createTestUser(app, { email: "other@example.com" });

        const res = await app.inject({
            method: "GET",
            url: `/uploads/${chunkSetId}/chunks/0`,
            headers: { cookie: otherCookie },
        });
        expect(res.statusCode).toBe(404);
    });
});

// ── The integral happy path ───────────────────────────────────────────────────

describe("Full upload → file item → storage roundtrip", () => {
    test("open→presigned upload→finalize→create file item→storage used", async () => {
        const chunkSetId = await fullUpload([CHUNK_BODY]);

        const itemId = uuidv7();
        const itemRes = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(itemId, chunkSetId),
        });
        expect(itemRes.statusCode).toBe(201);
        expect(itemRes.json().chunk_set_id).toBe(chunkSetId);

        const storageRes = await app.inject({
            method: "GET",
            url: "/me/storage",
            headers: { cookie },
        });
        expect(storageRes.json().breakdown.files_bytes).toBe(CHUNK_BODY.length);
    });

    test("trying to create a file item with an uncommitted set → 409", async () => {
        const openRes = await openUpload();
        const { chunk_set_id } = openRes.json() as OpenUploadBody;

        const res = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(uuidv7(), chunk_set_id),
        });
        expect(res.statusCode).toBe(409);
    });

    test("uploading two independent sets plus their items — both present in storage", async () => {
        // V3: chunk sets count only once they are bound to a READY item
        const setId1 = await fullUpload([Buffer.allocUnsafe(100).fill(1)]);
        const setId2 = await fullUpload([Buffer.allocUnsafe(200).fill(2)]);

        expect(await countChunkSets()).toBe(2);

        // Create file items for both sets
        const r1 = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(uuidv7(), setId1),
        });
        expect(r1.statusCode).toBe(201);

        const r2 = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(uuidv7(), setId2),
        });
        expect(r2.statusCode).toBe(201);

        const storageRes = await app.inject({
            method: "GET",
            url: "/me/storage",
            headers: { cookie },
        });
        expect(storageRes.json().breakdown.files_bytes).toBe(300);
    });

    test("enforcement (storage_used_files) == GET /me/storage — every path (reserve/finalize/orphan/purge)", async () => {
        // Helper: GET /me/storage → { used }
        const getUsed = async () => {
            const r = await app.inject({ method: "GET", url: "/me/storage", headers: { cookie } });
            expect(r.statusCode).toBe(200);
            return r.json().breakdown.files_bytes as number;
        };

        // At the start: both 0
        expect(await getUserStorageUsed(userEmail)).toBe(0);
        expect(await getUsed()).toBe(0);

        // --- Reserve (open) ---
        const openRes = await openUpload();
        expect(openRes.statusCode).toBe(201);
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        // storage_used_files and what is displayed have to match
        expect(await getUsed()).toBe(await getUserStorageUsed(userEmail));

        // --- Finalize WITHOUT creating an item = a committed orphan ---
        const put_urls = await mintPutUrls(chunk_set_id, 1);
        await putChunkS3(put_urls[0]!);
        const finRes = await finalize(chunk_set_id);
        expect(finRes.statusCode).toBe(200);

        // The key check: enforcement == what is displayed, even for a committed orphan
        const storageUsedAfterFinalize = await getUserStorageUsed(userEmail);
        expect(storageUsedAfterFinalize).toBe(CHUNK_BODY.length);
        expect(await getUsed()).toBe(storageUsedAfterFinalize); // <-- this fails without the fix

        // --- Create the item (an active file) and check again ---
        const itemId = uuidv7();
        const itemRes = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(itemId, chunk_set_id),
        });
        expect(itemRes.statusCode).toBe(201);
        expect(await getUsed()).toBe(await getUserStorageUsed(userEmail));

        // --- Soft delete (trash): storage_used_files does NOT shrink, the quota stays the same ---
        const trashRes = await app.inject({
            method: "DELETE",
            url: `/items/${itemId}`,
            headers: { cookie },
        });
        expect(trashRes.statusCode).toBe(200);
        expect(await getUsed()).toBe(await getUserStorageUsed(userEmail)); // still equal

        // --- Purge: storage_used_files and what is displayed both drop to 0 ---
        const purgeRes = await app.inject({
            method: "DELETE",
            url: `/items/${itemId}/purge`,
            headers: { cookie },
        });
        expect(purgeRes.statusCode).toBe(200);
        expect(await getUserStorageUsed(userEmail)).toBe(0);
        expect(await getUsed()).toBe(0);
    });
});

// ── Presigned PUT ContentLength enforcement ───────────────────────────────────

describe("ContentLength enforcement: an oversized chunk is rejected by S3 or by finalize", () => {
    test("declare a small chunk, send a larger one → finalize returns 409", async () => {
        const DECLARED = CHUNK_BODY.length; // 64 B
        const OVERSIZED = Buffer.allocUnsafe(DECLARED * 2).fill(0xcd); // 128 B

        // Open a session with an exactly declared size (the PUT URL is signed for DECLARED bytes).
        const openRes = await openUpload({
            chunks: 1,
            totalSize: DECLARED,
            chunkSizes: [DECLARED],
        });
        expect(openRes.statusCode).toBe(201);
        const { chunk_set_id } = openRes.json() as OpenUploadBody;
        const put_urls = await mintPutUrls(chunk_set_id, 1);

        // Send an oversized body.
        // S3-compatible stores vary here: some refuse it immediately (403 ContentLength
        // mismatch), some accept it (no enforcement).
        const putRes = await putChunkS3(put_urls[0]!, OVERSIZED);
        if (!putRes.ok) {
            // At the S3 level: a URL carrying ContentLength blocked the oversized upload — the test passes.
            expect([400, 403]).toContain(putRes.status);
            return;
        }

        // S3 accepted the oversized object → finalize has to detect the size mismatch.
        const finalRes = await finalize(chunk_set_id);
        expect(finalRes.statusCode).toBe(409);
        expect(finalRes.json().detail.got_size).toBe(OVERSIZED.length);
        expect(finalRes.json().detail.expected_size).toBe(DECLARED);
    });

    test("a normal upload with exact chunk_sizes goes the whole way (open → put → finalize → item)", async () => {
        const chunkSetId = await fullUpload([CHUNK_BODY]);

        const itemRes = await app.inject({
            method: "POST",
            url: "/items",
            headers: { cookie },
            payload: filePayload(uuidv7(), chunkSetId),
        });
        expect(itemRes.statusCode).toBe(201);
        expect(itemRes.json().chunk_set_id).toBe(chunkSetId);
    });

    test("chunk_sizes does not match expected_chunks → 400 (schema validation)", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/uploads",
            headers: { cookie },
            payload: {
                expected_chunks: 2,
                total_size: 128,
                chunk_sizes: [128], // length=1, a expected_chunks=2 → mismatch
            },
        });
        expect(res.statusCode).toBe(400);
    });

    test("Σ(chunk_sizes) ≠ total_size → 400 (schema validation)", async () => {
        const res = await app.inject({
            method: "POST",
            url: "/uploads",
            headers: { cookie },
            payload: {
                expected_chunks: 2,
                total_size: 100,
                chunk_sizes: [64, 64], // 64+64=128 ≠ 100
            },
        });
        expect(res.statusCode).toBe(400);
    });
});

describe("the IP rate limit on the upload routes", () => {
    let rlApp: FastifyInstance;
    let prevFlag: string | undefined;
    let prevOpenMax: string | undefined;

    beforeAll(async () => {
        prevFlag = process.env.RATE_LIMIT_IN_TEST;
        prevOpenMax = process.env.UPLOAD_OPEN_RATE_LIMIT_MAX;
        process.env.RATE_LIMIT_IN_TEST = "1";
        process.env.UPLOAD_OPEN_RATE_LIMIT_MAX = "5";
        rlApp = await buildApp();
        await rlApp.ready();
    });

    afterAll(async () => {
        await rlApp.close();
        if (prevFlag === undefined) delete process.env.RATE_LIMIT_IN_TEST;
        else process.env.RATE_LIMIT_IN_TEST = prevFlag;
        if (prevOpenMax === undefined) delete process.env.UPLOAD_OPEN_RATE_LIMIT_MAX;
        else process.env.UPLOAD_OPEN_RATE_LIMIT_MAX = prevOpenMax;
    });

    test("POST /uploads → 429 rate_limit_exceeded after a burst", async () => {
        const { cookie: rlCookie } = await createTestUser(rlApp, {
            email: "rl-upload@example.com",
        });

        let limited = false;
        for (let i = 0; i < 10; i++) {
            const res = await rlApp.inject({
                method: "POST",
                url: "/uploads",
                headers: { cookie: rlCookie },
                payload: {
                    expected_chunks: 1,
                    total_size: 64,
                    chunk_sizes: [64],
                },
            });
            if (res.statusCode === 429) {
                limited = true;
                expect(res.json().error).toBe("rate_limit_exceeded");
                break;
            }
            expect(res.statusCode).toBe(201);
            const { chunk_set_id } = res.json() as OpenUploadBody;
            // Abort so we do not hit MAX_CONCURRENT_UPLOAD_SESSIONS before the IP rate limit.
            await rlApp.inject({
                method: "DELETE",
                url: `/uploads/${chunk_set_id}`,
                headers: { cookie: rlCookie },
            });
        }
        expect(limited).toBe(true);
    });

    test("the chunk GET has a loose limit — 50 requests do not return 429", async () => {
        const freshApp = await buildApp();
        await freshApp.ready();
        try {
            const { cookie: rlCookie, email } = await createTestUser(freshApp, {
                email: "rl-chunk@example.com",
            });
            const open = await freshApp.inject({
                method: "POST",
                url: "/uploads",
                headers: { cookie: rlCookie },
                payload: {
                    expected_chunks: 1,
                    total_size: 64,
                    chunk_sizes: [64],
                },
            });
            const { chunk_set_id } = open.json() as OpenUploadBody;
            const userId = await getUserIdByEmail(email);
            await s3.send(
                new PutObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: `u/${userId}/${chunk_set_id}/0`,
                    Body: CHUNK_BODY,
                }),
            );
            await freshApp.inject({
                method: "POST",
                url: `/uploads/${chunk_set_id}/finalize`,
                headers: { cookie: rlCookie },
            });

            for (let i = 0; i < 50; i++) {
                const res = await freshApp.inject({
                    method: "GET",
                    url: `/uploads/${chunk_set_id}/chunks/0`,
                    headers: { cookie: rlCookie },
                });
                expect(res.statusCode).not.toBe(429);
            }
        } finally {
            await freshApp.close();
        }
    });
});
