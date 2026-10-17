// The process start, in one place: what a running API needs beyond `buildApp` — the storage bucket,
// the health route, `listen`, and the background schedulers. An installation that adds extensions
// (seam 1) passes its own list here instead of copying this sequence, because a copy drifts: the
// health route goes missing, or a scheduler is handed the logger instead of the instance.
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { startGcScheduler } from "./gc-scheduler";
import { health } from "./routes/health";
import { ensureS3Bucket, S3_BUCKET } from "./s3";
import type { ApiExtension } from "./server";
import { startAnalyticsScheduler } from "./services/analytics/scheduler";

/**
 * Builds the app with `extensions` (the open-core default when omitted) and brings the process up.
 * A failure to start exits the process — a half-started API has nothing useful to offer.
 */
export async function startServer(
    opts: { extensions?: readonly ApiExtension[] } = {},
): Promise<FastifyInstance> {
    try {
        const fastify = await buildApp({ logger: true, ...opts });

        // A dev Garage often starts empty (a volume wipe, or the first up) — without the bucket
        // a presigned PUT returns 404 NoSuchBucket. In production the bucket must already exist
        // (create it with your storage provider).
        try {
            await ensureS3Bucket();
        } catch (e) {
            // Do not take the API down because storage is not up yet — the file routes will come
            // alive later anyway. In dev, log clearly so it is obvious why an upload fails with
            // "not found".
            fastify.log.error(
                { err: e },
                `S3 bucket "${S3_BUCKET}" unavailable — file uploads will fail until storage is ready`,
            );
        }

        // Registered here rather than inside `buildApp` on purpose: it is an ops route, not part
        // of the application surface the client routes to (see test/route-exposure.test.ts).
        await fastify.register(health);

        const port = process.env.PORT ? Number(process.env.PORT) : 3000;
        const host = process.env.HOST || "127.0.0.1";
        await fastify.listen({ port, host });
        fastify.log.info(`Server running at http://${host}:${port}`);

        startGcScheduler(fastify);
        startAnalyticsScheduler(fastify);
        return fastify;
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
