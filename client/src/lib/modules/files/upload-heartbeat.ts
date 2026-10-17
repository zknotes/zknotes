// A heartbeat against the GC of stale upload sessions.
import { pingUploadSession } from "$lib/core/api";
import { ApiError } from "$lib/core/api/client";
import { UploadPipelineError } from "./upload-errors";

export const ACTIVE_HEARTBEAT_MS = 5 * 60 * 1000;
export const PAUSED_HEARTBEAT_MS = 30 * 60 * 1000;

export type PingResult = "ok" | "expired";

/** Pings the session; a session the server no longer has (404/410) or aborted → expired. */
export async function pingOrExpire(chunkSetId: string): Promise<PingResult> {
    try {
        const res = await pingUploadSession(chunkSetId);
        if (res.session_status === "aborted") return "expired";
        return "ok";
    } catch (err) {
        // By status: the text of a 404 is the code `no_session`, not "not found".
        if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
            return "expired";
        }
        throw err;
    }
}

export function throwIfSessionExpired(chunkSetId: string): never {
    throw new UploadPipelineError(
        `Upload session expired (${chunkSetId})`,
        "fatal_session",
        "failed_expired",
    );
}

/** The active upload heartbeat — tick() inside the upload loop. */
export function createActiveHeartbeat(chunkSetId: string): {
    tick: () => Promise<void>;
    stop: () => void;
} {
    let lastPing = Date.now();
    let stopped = false;

    return {
        async tick() {
            if (stopped) return;
            if (Date.now() - lastPing < ACTIVE_HEARTBEAT_MS) return;
            const result = await pingOrExpire(chunkSetId);
            lastPing = Date.now();
            if (result === "expired") throwIfSessionExpired(chunkSetId);
        },
        stop() {
            stopped = true;
        },
    };
}
