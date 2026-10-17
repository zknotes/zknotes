import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || "",
        secretAccessKey: process.env.S3_SECRET_KEY || "",
    },
    forcePathStyle: true, // Required for Garage/MinIO — they have no per-bucket subdomains
    // The SDK's default ("when_supported") adds an unsigned x-amz-checksum-crc32 query param to every
    // presigned PUT — computed as if the body were empty, since presigning never sees the body. S3
    // itself ignores the mismatch, but Garage validates it and rejects the upload with InvalidDigest.
    // "when_required" only attaches a checksum when the caller asks for one explicitly.
    requestChecksumCalculation: "WHEN_REQUIRED",
});

export const S3_BUCKET = process.env.S3_BUCKET || "zknotes";

/** The credentials the development stack and server/.env.example ship with. */
const DEV_S3_CREDENTIALS = new Set(["minioadmin", "minioadmin-dev-secret"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * What is wrong with an S3 configuration for production, one sentence per problem. Without this the
 * API starts with the example file's values, `/health` stays green, and every upload fails later.
 */
export function productionS3ConfigProblems(env: {
    S3_ENDPOINT?: string;
    S3_ACCESS_KEY?: string;
    S3_SECRET_KEY?: string;
}): string[] {
    const problems: string[] = [];
    for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY"] as const) {
        const value = env[name]?.trim() ?? "";
        if (value === "") problems.push(`${name} is not set.`);
        else if (DEV_S3_CREDENTIALS.has(value)) problems.push(`${name} is the development value.`);
    }
    if (env.S3_ENDPOINT) {
        let url: URL | undefined;
        try {
            url = new URL(env.S3_ENDPOINT);
        } catch {
            problems.push("S3_ENDPOINT is not a URL.");
        }
        // Browsers upload straight to S3_ENDPOINT, so it must be an address they can reach — and,
        // from an https:// page, an https:// one: a plain http:// endpoint (a Docker service name,
        // typically) is blocked as mixed content.
        if (url && LOOPBACK_HOSTS.has(url.hostname))
            problems.push("S3_ENDPOINT points at this machine's loopback.");
        else if (url && url.protocol !== "https:")
            problems.push("S3_ENDPOINT is not an https:// address.");
    }
    return problems;
}

if (process.env.NODE_ENV === "production") {
    const problems = productionS3ConfigProblems({
        S3_ENDPOINT: process.env.S3_ENDPOINT,
        S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
        S3_SECRET_KEY: process.env.S3_SECRET_KEY,
    });
    if (problems.length > 0) {
        throw new Error(`Object storage is not configured for production: ${problems.join(" ")}`);
    }
}

// Network errors towards S3 (a Garage that is down, say) arrive from the SDK as a bare
// "ECONNREFUSED" that shows nothing of the cause. Middleware on the "initialize" step (outside the
// retry layer — it catches the final error after every attempt) appends the endpoint and a hint to
// err.message, so every existing log site ({ err: e }) automatically gets a clear message.
const CONNECTION_ERROR_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "EPIPE",
]);

s3.middlewareStack.add(
    (next) => async (args) => {
        try {
            return await next(args);
        } catch (e) {
            const err = e as Error & { code?: string };
            if (err.code !== undefined && CONNECTION_ERROR_CODES.has(err.code)) {
                const endpoint = process.env.S3_ENDPOINT || "AWS S3";
                err.message =
                    `S3 storage unreachable (${err.code}) at ${endpoint} — ` +
                    "check that S3/Garage is running (in dev: docker compose up -d garage)";
            }
            throw err;
        }
    },
    { step: "initialize", name: "s3UnreachableHint" },
);

/**
 * Check that S3_BUCKET exists. In dev (Garage) it is created when missing — otherwise a presigned
 * PUT fails with 404 NoSuchBucket and the client sees "Upload failed: not found".
 * In production the bucket is not created automatically; create it with your storage provider.
 */
export async function ensureS3Bucket(): Promise<void> {
    try {
        await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
        return;
    } catch (e) {
        const err = e as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
        const status = err.$metadata?.httpStatusCode;
        const missing =
            status === 404 ||
            err.name === "NotFound" ||
            err.name === "NoSuchBucket" ||
            /not found|nosuchbucket/i.test(err.message ?? "");
        if (!missing) throw e;
    }

    const isDev = process.env.NODE_ENV !== "production";
    const autoCreate =
        isDev ||
        process.env.S3_AUTO_CREATE_BUCKET === "1" ||
        process.env.S3_AUTO_CREATE_BUCKET === "true";
    if (!autoCreate) {
        throw new Error(
            `S3 bucket "${S3_BUCKET}" does not exist (endpoint: ${process.env.S3_ENDPOINT || "default"}). ` +
                "Create it in the object-store console, or set S3_AUTO_CREATE_BUCKET=1 for local Garage.",
        );
    }

    try {
        await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
    } catch (e) {
        const err = e as Error & { name?: string };
        // A race with another process, or it already exists.
        if (err.name === "BucketAlreadyOwnedByYou" || err.name === "BucketAlreadyExists") return;
        throw e;
    }
}
