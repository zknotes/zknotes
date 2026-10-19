// The client for the restore wizard's routes. The error body is kept because a 409
// `restore_already_open` carries the `restore_session_id` needed to continue.
import type { RestoreManifestItem, RestoreMode, RestoreStagedItem } from "@zknotes/shared";
import { ApiError, apiFetch } from "./client";

export class RestoreClientError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly body: Record<string, unknown>,
    ) {
        super(message);
        this.name = "RestoreClientError";
    }
}

export interface RestoreVerdict {
    ok: boolean;
    blockers: Array<{ code: string; [key: string]: unknown }>;
    mode: RestoreMode;
    counts: {
        manifest_items: number;
        collide_live: number;
        collide_trashed: number;
        collide_purged: number;
        /** Purged entries whose remap target already exists — they collide there. */
        collide_remapped: number;
        creates: number;
        overwrites: number;
        skips: number;
    };
    /** Live and trashed also hold remap targets, so the skip set works on the ids after the remap. */
    collisions: { live: string[]; trashed: string[]; purged: string[] };
    /** A purged manifest id → the id it comes back under; the wizard stages under it. */
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

export interface RestoreSessionView {
    restore_session_id: string;
    status: string;
    backup_hash: string;
    mode: RestoreMode;
    staged_items: number;
    staged_blobs: number;
    missing: { items: string[]; blobs: string[] };
    verdict: RestoreVerdict;
    expires_at: number;
}

export interface RestoreVerifyResult {
    ok: boolean;
    blockers: Array<{ code: string; [key: string]: unknown }>;
    verdict: RestoreVerdict;
    missing: { items: string[]; blobs: string[] };
    version_drift: Array<{ id: string; expected: number; actual: number }>;
}

// A restore call may have to wait on the server staging or committing a large backup.
const RESTORE_TIMEOUT_MS = 120_000;

/**
 * The one transport (`apiFetch`: offline short-circuit, timeout, and the 401/403 session teardown)
 * with the error re-thrown under the wizard's own name, body included. An earlier private copy of
 * the transport here skipped the teardown, so a session that expired mid-restore left the vault open.
 */
async function restoreFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    try {
        return await apiFetch<T>(endpoint, { ...options, timeoutMs: RESTORE_TIMEOUT_MS });
    } catch (e) {
        if (e instanceof ApiError) {
            throw new RestoreClientError(e.message, e.status, e.body ?? { error: e.message });
        }
        throw e;
    }
}

export async function createRestoreSession(input: {
    backup_hash: string;
    manifest: RestoreManifestItem[];
    mode: RestoreMode;
}): Promise<{ restore_session_id: string; verdict: RestoreVerdict }> {
    return restoreFetch("/restore/sessions", {
        method: "POST",
        body: JSON.stringify(input),
    });
}

export async function getRestoreSession(id: string): Promise<RestoreSessionView> {
    return restoreFetch(`/restore/sessions/${id}`);
}

export async function stageRestoreItems(
    id: string,
    items: RestoreStagedItem[],
): Promise<{ staged: number; skipped: number }> {
    return restoreFetch(`/restore/sessions/${id}/items`, {
        method: "POST",
        body: JSON.stringify({ items }),
    });
}

export async function pingRestoreSession(
    id: string,
): Promise<{ ok: boolean; expires_at?: number }> {
    return restoreFetch(`/restore/sessions/${id}/ping`, { method: "POST" });
}

export async function verifyRestoreSession(id: string): Promise<RestoreVerifyResult> {
    return restoreFetch(`/restore/sessions/${id}/verify`, {
        method: "POST",
        body: JSON.stringify({}),
    });
}

export async function commitRestoreSession(id: string): Promise<{ ok: boolean }> {
    return restoreFetch(`/restore/sessions/${id}/commit`, {
        method: "POST",
        body: JSON.stringify({}),
    });
}

export async function abortRestoreSession(id: string): Promise<{ ok: boolean }> {
    return restoreFetch(`/restore/sessions/${id}/abort`, { method: "POST" });
}
