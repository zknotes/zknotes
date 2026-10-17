declare namespace NodeJS {
    interface ProcessEnv {
        DATABASE_URL?: string;
        S3_ENDPOINT?: string;
        S3_REGION?: string;
        S3_BUCKET?: string;
        S3_ACCESS_KEY?: string;
        S3_SECRET_KEY?: string;
        NODE_ENV?: "development" | "production" | "test";
        PORT?: string;
        CORS_ORIGIN?: string;
        COOKIE_SECRET?: string;
        KDF_FAKE_SEED?: string;
        MIN_AUTH_RESPONSE_MS?: string;
        AUTH_JITTER_MS?: string;
        /** Fastify trustProxy: a CSV of the reverse proxies' IPs/CIDRs (see parseTrustProxy). */
        TRUST_PROXY?: string;
        ARGON2_MEMORY_COST?: string;
        ARGON2_TIME_COST?: string;
        ARGON2_PARALLELISM?: string;
        GC_DISABLED?: string;
        GC_INTERVAL_MS?: string;
        GC_DEEP_INTERVAL_MS?: string;
        BLOB_PURGE_GRACE_SECONDS?: string;
        GC_STALE_UPLOAD_SECONDS?: string;
        SESSION_TTL_SECONDS?: string;
        // ── Runtime links served by GET /instance-config (never build inputs) ──
        PUBLIC_WWW_URL?: string;
        ACCOUNT_MANAGE_URL?: string;
        SOURCE_URL?: string;
        SYNC_DELETED_LOG_RETENTION_DAYS?: string;
        TOMBSTONE_PURGE_DAYS?: string;
        /** Delta-pull watermark safety window in ms (default 30000). Issued server_time = now − this. */
        SYNC_WATERMARK_SAFETY_MS?: string;
        /** Authenticated mutation IP layer (onRequest). Default 600/min. */
        AUTHENTICATED_MUTATION_RATELIMIT_MAX?: string;
        AUTHENTICATED_MUTATION_RATELIMIT_WINDOW?: string;
        /** Authenticated mutation per-user layer (preHandler). Default 600/min. */
        AUTHENTICATED_MUTATION_USER_RATELIMIT_MAX?: string;
        /** Authenticated read IP layer for GETs that previously had no limit. Default 600/min. */
        AUTHENTICATED_READ_IP_RATELIMIT_MAX?: string;
        /** Authenticated read per-user layer. Default 120/min. */
        AUTHENTICATED_READ_USER_RATELIMIT_MAX?: string;
        AUTHENTICATED_READ_RATELIMIT_WINDOW?: string;
    }
}
