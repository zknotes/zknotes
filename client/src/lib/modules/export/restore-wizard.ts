// The orchestration of the transactional restore wizard.
// The backup file is deliberately not persisted — on a resume the user picks the same one again.
import {
    FILE_LIMITS,
    RESTORE_LIMITS,
    type EncryptedItem,
    type RestoreManifestItem,
    type RestoreMode,
    type RestoreStagedItem,
    restoreRemapId,
    topoSortByParent,
} from "@zknotes/shared";
import {
    abortRestoreSession,
    commitRestoreSession,
    createRestoreSession,
    getRestoreSession,
    pingRestoreSession,
    RestoreClientError,
    stageRestoreItems,
    type RestoreVerdict,
    verifyRestoreSession,
} from "$lib/core/api/restore";
import { getDB, type LocalItem } from "$lib/core/db";
import { fileBridge } from "$lib/core/events/file-bridge";
import { pullAndMerge } from "$lib/core/sync/engine";
import { syncStore } from "$lib/core/sync/store.svelte";
import { withSyncLock } from "$lib/core/sync/sync-lock";
import { fromBase64, toBase64 } from "$lib/core/utils/base64";
import { clearRestoreUiKeys } from "$lib/core/utils/clear-vault-ui-keys";
import {
    addCachedItemKey,
    encryptPayloadTask,
    encryptPayloadWithNewKeyTask,
} from "$lib/core/workers/crypto-rpc";
import type { BackupFile, BackupItem, BackupNote } from "./full-backup";
import type { ParsedBackup } from "./full-backup-import";
import { remapPurgedIds } from "./id-remap";

export { clearRestoreUiKeys };

export const RESTORE_META_KEY = "restore-session";
const PING_MS = 60_000;

export interface PersistedRestore {
    restore_session_id: string;
    backup_hash: string;
    mode: RestoreMode;
    phase: "staging" | "verify" | "commit" | "replace";
    staged_ids: string[];
}

export interface ActiveRestore {
    sessionId: string;
    backupHash: string;
    mode: RestoreMode;
    verdict: RestoreVerdict;
    items: BackupItem[];
    fileMap: Map<string, Uint8Array>;
    idMap: Map<string, string>;
    missing: { items: string[]; blobs: string[] };
    stagedIds: string[];
}

export type BeginRestoreResult =
    | { status: "pending_unsynced"; pendingCount: number }
    | { status: "wrong_backup" }
    | { status: "other_session"; restore_session_id: string; backup_hash: string }
    | { status: "preflight"; session: ActiveRestore };

export type ExecuteRestoreResult =
    | { status: "blocked"; blockers: Array<{ code: string; [key: string]: unknown }> }
    | { status: "committed_dirty"; leftoverDirty: string[] }
    | { status: "done" };

export interface RestoreProgress {
    done: number;
    total: number;
    label: string;
}

let blockingUnload = false;

export function isRestoreBlockingUnload(): boolean {
    return blockingUnload;
}

export function setRestoreBlockingUnload(v: boolean): void {
    blockingUnload = v;
}

export async function hashBackupBytes(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadPersistedRestore(): Promise<PersistedRestore | null> {
    const db = await getDB();
    const raw = await db.get("metadata", RESTORE_META_KEY);
    if (!raw || typeof raw !== "object") return null;
    return raw as PersistedRestore;
}

export async function savePersistedRestore(value: PersistedRestore | null): Promise<void> {
    const db = await getDB();
    if (value == null) {
        await db.delete("metadata", RESTORE_META_KEY);
        return;
    }
    // A JSON round trip: a Svelte 5 $state proxy must not go into IDB (a DataCloneError).
    await db.put(
        "metadata",
        JSON.parse(JSON.stringify(value)) as PersistedRestore,
        RESTORE_META_KEY,
    );
}

/** An exported test seam — see restore-wizard.integration.test.ts. */
export function noteOrFolderPayload(item: BackupItem): Record<string, unknown> {
    const payload: Record<string, unknown> = { title: item.type === "file" ? "" : item.title };
    if (item.type === "note") {
        const note = item as BackupNote;
        payload.content = note.content ?? "";
        if (note.contentTitle !== undefined) payload.contentTitle = note.contentTitle;
        if (note.outlineVisible !== undefined) payload.outlineVisible = note.outlineVisible;
    }
    if (item.type !== "file") {
        if (item.color) payload.color = item.color;
        if (item.icon) payload.icon = item.icon;
        if (item.starred !== undefined) payload.starred = item.starred;
    }
    return payload;
}

function ciphertextSizeForFile(plainSize: number): number {
    const chunks = Math.max(1, Math.ceil(plainSize / FILE_LIMITS.CHUNK_SIZE));
    return plainSize + chunks * FILE_LIMITS.AEAD_TAG;
}

function manifestByteSize(item: BackupItem, fileMap: Map<string, Uint8Array>): number {
    if (item.type === "file") {
        const bytes = fileMap.get(item.id);
        const size = bytes?.byteLength ?? (item as BackupFile).size;
        return ciphertextSizeForFile(size);
    }
    const json = new TextEncoder().encode(JSON.stringify(noteOrFolderPayload(item)));
    return json.byteLength + FILE_LIMITS.AEAD_TAG;
}

function applyRemap(
    parsed: ParsedBackup,
    verdict: RestoreVerdict,
    backupHash: string,
): { items: BackupItem[]; fileMap: Map<string, Uint8Array>; idMap: Map<string, string> } {
    // The server resolves the id each purged entry comes back under: a later generation
    // when an earlier restore's copy is purged too. Without an entry, generation 0 — and the
    // verdict then carries the blocker that says why.
    return remapPurgedIds(
        parsed.items,
        parsed.fileMap,
        verdict.collisions.purged,
        (oldId) => verdict.remaps?.[oldId] ?? restoreRemapId(backupHash, oldId),
        backupHash,
    );
}

function buildManifest(
    items: BackupItem[],
    fileMap: Map<string, Uint8Array>,
): RestoreManifestItem[] {
    return items.map((item) => ({
        id: item.id,
        type: item.type,
        parent_id: item.parent_id,
        byte_size: manifestByteSize(item, fileMap),
    }));
}

async function persistProgress(
    session: Pick<ActiveRestore, "sessionId" | "backupHash" | "mode" | "stagedIds">,
    phase: PersistedRestore["phase"],
): Promise<void> {
    await savePersistedRestore({
        restore_session_id: session.sessionId,
        backup_hash: session.backupHash,
        mode: session.mode,
        phase,
        staged_ids: session.stagedIds,
    });
}

async function bindSession(
    sessionId: string,
    backupHash: string,
    mode: RestoreMode,
    parsed: ParsedBackup,
    verdict: RestoreVerdict,
    missing: { items: string[]; blobs: string[] },
    stagedIds: string[] = [],
): Promise<ActiveRestore> {
    const remapped = applyRemap(parsed, verdict, backupHash);
    const session: ActiveRestore = {
        sessionId,
        backupHash,
        mode,
        verdict,
        items: remapped.items,
        fileMap: remapped.fileMap,
        idMap: remapped.idMap,
        missing,
        stagedIds: [...stagedIds],
    };
    await persistProgress(session, "staging");
    return session;
}

export async function beginRestore(opts: {
    parsed: ParsedBackup;
    backupHash: string;
    mode: RestoreMode;
}): Promise<BeginRestoreResult> {
    const pendingCount = syncStore.pendingCount;
    if (pendingCount > 0) {
        return { status: "pending_unsynced", pendingCount };
    }

    const originalItems = opts.parsed.items;
    const originalMap = opts.parsed.fileMap;
    try {
        const created = await createRestoreSession({
            backup_hash: opts.backupHash,
            manifest: buildManifest(originalItems, originalMap),
            mode: opts.mode,
        });
        return {
            status: "preflight",
            session: await bindSession(
                created.restore_session_id,
                opts.backupHash,
                opts.mode,
                opts.parsed,
                created.verdict,
                { items: [], blobs: [] },
            ),
        };
    } catch (e) {
        if (
            e instanceof RestoreClientError &&
            e.status === 409 &&
            e.body.error === "restore_already_open"
        ) {
            const existingId = String(e.body.restore_session_id ?? "");
            if (!existingId) throw e;
            const view = await getRestoreSession(existingId);
            if (view.backup_hash !== opts.backupHash) {
                return {
                    status: "other_session",
                    restore_session_id: existingId,
                    backup_hash: view.backup_hash,
                };
            }
            return {
                status: "preflight",
                session: await bindSession(
                    existingId,
                    opts.backupHash,
                    view.mode,
                    opts.parsed,
                    view.verdict,
                    view.missing,
                ),
            };
        }
        throw e;
    }
}

export async function resumeRestore(opts: {
    parsed: ParsedBackup;
    backupHash: string;
}): Promise<BeginRestoreResult> {
    const persisted = await loadPersistedRestore();
    if (persisted && persisted.backup_hash !== opts.backupHash) {
        return { status: "wrong_backup" };
    }
    if (persisted) {
        const view = await getRestoreSession(persisted.restore_session_id);
        if (view.backup_hash !== opts.backupHash) return { status: "wrong_backup" };
        return {
            status: "preflight",
            session: await bindSession(
                persisted.restore_session_id,
                opts.backupHash,
                view.mode,
                opts.parsed,
                view.verdict,
                view.missing,
                persisted.staged_ids ?? [],
            ),
        };
    }
    return beginRestore({ ...opts, mode: "skip_existing" });
}

/** The stored wrap of an existing item's key, as the local row holds it (base64). */
interface KeptItemKey {
    encryptedItemKey: string;
    itemKeyNonce: string;
}

/**
 * The keys Overwrite all must keep: a share link wraps the item's own Item Key, so a new
 * key on the same id leaves every link to it unreadable. Upload does the same for a file it
 * overwrites. The wrap comes from this device's copy of each colliding item — one pull fills in
 * what is missing, and a restore that still lacks one stops before anything is staged rather than
 * quietly re-keying it.
 */
async function keptItemKeys(
    session: ActiveRestore,
    toStage: ReadonlySet<string>,
): Promise<Map<string, KeptItemKey>> {
    const kept = new Map<string, KeptItemKey>();
    if (session.mode !== "overwrite_all") return kept;
    const ids = [...session.verdict.collisions.live, ...session.verdict.collisions.trashed].filter(
        (id) => toStage.has(id),
    );
    const read = async () => {
        const db = await getDB();
        for (const id of ids) {
            if (kept.has(id)) continue;
            const row = await db.get("items", id);
            if (row?.encrypted_item_key && row.item_key_nonce) {
                kept.set(id, {
                    encryptedItemKey: row.encrypted_item_key,
                    itemKeyNonce: row.item_key_nonce,
                });
            }
        }
    };
    await read();
    if (kept.size < ids.length) {
        await pullAndMerge();
        await read();
    }
    const missing = ids.length - kept.size;
    if (missing > 0) {
        throw new Error(
            `This device does not have ${missing} of the items this restore would overwrite. Let it finish syncing, then try again.`,
        );
    }
    return kept;
}

async function encryptNoteOrFolder(
    item: BackupItem,
    version: number,
    kept?: KeptItemKey,
): Promise<EncryptedItem> {
    const payload = noteOrFolderPayload(item);
    let encryptedItemKey: string;
    let itemKeyNonce: string;
    let sealed: { ciphertext: Uint8Array; nonce: Uint8Array };
    if (kept) {
        // Only the wrap crosses into the worker, as in any ordinary save; the raw key stays there.
        await addCachedItemKey(
            item.id,
            fromBase64(kept.encryptedItemKey),
            fromBase64(kept.itemKeyNonce),
        );
        sealed = await encryptPayloadTask(item.id, payload, version);
        encryptedItemKey = kept.encryptedItemKey;
        itemKeyNonce = kept.itemKeyNonce;
    } else {
        const fresh = await encryptPayloadWithNewKeyTask(item.id, payload, version);
        sealed = fresh;
        encryptedItemKey = toBase64(new Uint8Array(fresh.encryptedItemKey));
        itemKeyNonce = toBase64(new Uint8Array(fresh.itemKeyNonce));
    }
    return {
        id: item.id,
        type: item.type,
        parent_id: item.parent_id,
        encrypted_payload: toBase64(new Uint8Array(sealed.ciphertext)),
        payload_nonce: toBase64(new Uint8Array(sealed.nonce)),
        encrypted_item_key: encryptedItemKey,
        item_key_nonce: itemKeyNonce,
        sort_order: item.sort_order,
        version,
        created_at: item.created_at,
        updated_at: item.updated_at,
    };
}

/**
 * An item restored under a new id (its original was purged) names that original, so the server
 * can recompute the remap instead of refusing the new id as `not_in_manifest`.
 */
function withRemapProof(enc: EncryptedItem, originals: Map<string, string>): RestoreStagedItem {
    const original = originals.get(enc.id);
    return original ? { ...enc, remapped_from: original } : enc;
}

async function flushItemBatch(session: ActiveRestore, batch: RestoreStagedItem[]): Promise<void> {
    if (batch.length === 0) return;
    const ids = batch.map((i) => i.id);
    await stageRestoreItems(session.sessionId, batch);
    for (const id of ids) {
        if (!session.stagedIds.includes(id)) session.stagedIds.push(id);
    }
    await persistProgress(session, "staging");
    batch.length = 0;
}

/**
 * A staging run that follows an earlier one on the same session — "Confirm restore" again after an
 * error — asks the server what it still lacks. The preflight's `missing` is empty for a new session,
 * so without this a retry sent nothing and stopped at `incomplete_staging` every time.
 */
async function refreshMissing(session: ActiveRestore): Promise<void> {
    const view = await getRestoreSession(session.sessionId);
    if (view.status !== "open") {
        throw new Error(
            "This restore has ended on the server. Cancel it and start the restore again.",
        );
    }
    session.missing = view.missing;
}

async function stageAll(
    session: ActiveRestore,
    onProgress?: (p: RestoreProgress) => void,
): Promise<void> {
    if (session.stagedIds.length > 0) await refreshMissing(session);
    const skip = new Set([
        ...(session.mode === "skip_existing" ? session.verdict.collisions.live : []),
        ...(session.mode === "skip_existing" ? session.verdict.collisions.trashed : []),
    ]);
    const missingSet = new Set(session.missing.items);
    const missingBlobs = new Set(session.missing.blobs);
    // new id → the original manifest id, for the remapped items only.
    const originals = new Map([...session.idMap].map(([oldId, newId]) => [newId, oldId]));
    const resume = session.stagedIds.length > 0 || missingSet.size > 0 || missingBlobs.size > 0;

    // Parents before children. The shared sort is iterative and stops at a cycle (a backup taken
    // while one existed) instead of recursing until the stack overflows; the server's cycle check
    // then refuses the restore with a readable error.
    const candidates = topoSortByParent(session.items, (i) => i.parent_id ?? null).filter(
        (item) => {
            if (skip.has(item.id)) return false;
            if (!resume) return true;
            // On a resume the server's list decides (it is fresh from bindSession or refreshMissing),
            // not what this tab believes it sent; it lists a purged entry under its remapped id too.
            return missingSet.has(item.id) || missingBlobs.has(item.id);
        },
    );

    // Before anything is sent: a file keeps its key the same way, through startNewUpload's reuse of
    // the local row this makes sure exists.
    const keptKeys = await keptItemKeys(session, new Set(candidates.map((i) => i.id)));
    const notes = candidates.filter((i) => i.type !== "file");
    const files = candidates.filter((i) => i.type === "file");
    const total = notes.length + files.length;
    let done = 0;
    onProgress?.({ done, total, label: "Staging" });

    const pingTimer = setInterval(() => {
        void pingRestoreSession(session.sessionId).catch(() => {});
    }, PING_MS);
    await pingRestoreSession(session.sessionId).catch(() => {});

    try {
        const batch: RestoreStagedItem[] = [];
        let batchBytes = 0;
        for (const item of notes) {
            const version = session.verdict.expected_versions[item.id] ?? 1;
            const enc = withRemapProof(
                await encryptNoteOrFolder(item, version, keptKeys.get(item.id)),
                originals,
            );
            const size =
                (enc.encrypted_payload?.length ?? 0) + (enc.encrypted_item_key?.length ?? 0);
            if (
                batch.length >= RESTORE_LIMITS.MAX_STAGED_ITEMS_PER_REQUEST ||
                batchBytes + size > RESTORE_LIMITS.MAX_STAGED_BYTES_PER_REQUEST
            ) {
                await flushItemBatch(session, batch);
                batchBytes = 0;
            }
            batch.push(enc);
            batchBytes += size;
            done++;
            onProgress?.({ done, total, label: "Staging notes" });
        }
        await flushItemBatch(session, batch);

        const limit = RESTORE_LIMITS.MAX_PARALLEL_STAGING_UPLOADS;
        let next = 0;
        // Set by the first worker that fails: from then on no worker takes another file, so nothing
        // uploads behind an error the user has already been shown.
        let failed = false;
        let firstError: unknown;
        const stagedFiles: RestoreStagedItem[] = [];
        async function worker() {
            while (!failed && next < files.length) {
                try {
                    const item = files[next++] as BackupFile;
                    const bytes = session.fileMap.get(item.id);
                    if (!bytes) throw new Error(`Missing bytes for file ${item.id}`);
                    const file = new File([new Uint8Array(bytes)], item.name, {
                        type: item.mime || "application/octet-stream",
                    });
                    const version = session.verdict.expected_versions[item.id] ?? 1;
                    const enc = await fileBridge.stageRestoreUpload({
                        file,
                        parentId: item.parent_id,
                        name: item.name,
                        itemId: item.id,
                        restoreSessionId: session.sessionId,
                        sortOrder: item.sort_order,
                        createdAt: item.created_at,
                        version,
                        ...(item.description ? { description: item.description } : {}),
                    });
                    stagedFiles.push(withRemapProof(enc, originals));
                    done++;
                    onProgress?.({ done, total, label: "Staging files" });
                } catch (e) {
                    if (!failed) firstError = e;
                    failed = true;
                    return;
                }
            }
        }
        async function flushStagedFiles() {
            const fileBatch: RestoreStagedItem[] = [];
            for (const enc of stagedFiles) {
                if (fileBatch.length >= RESTORE_LIMITS.MAX_STAGED_ITEMS_PER_REQUEST) {
                    await flushItemBatch(session, fileBatch);
                }
                fileBatch.push(enc);
            }
            await flushItemBatch(session, fileBatch);
        }
        if (files.length > 0) {
            // Now, not after the first file finishes: until then the label would still read
            // "Staging notes" while every note is already done and an attachment is uploading.
            onProgress?.({ done, total, label: "Staging files" });
            // Every worker settles before anything is reported. The files that were
            // already uploading when one failed finish, and are staged below; otherwise the server
            // would go on listing them as missing, a retry would upload them all again, and those
            // uploads could still be running when the user starts it.
            await Promise.all(
                Array.from({ length: Math.min(limit, files.length) }, () => worker()),
            );
            if (failed) {
                // Keep what arrived, but the upload failure is what the user has to see.
                await flushStagedFiles().catch(() => {});
                throw firstError;
            }
            await flushStagedFiles();
        }
    } finally {
        clearInterval(pingTimer);
    }
}

async function leftoverDirtyIds(): Promise<string[]> {
    const db = await getDB();
    const dirty: string[] = [];
    for (const row of await db.getAll("items")) {
        if (row.dirty) dirty.push(row.id);
    }
    return dirty;
}

export async function executeRestore(
    session: ActiveRestore,
    onProgress?: (p: RestoreProgress) => void,
): Promise<ExecuteRestoreResult> {
    setRestoreBlockingUnload(true);
    syncStore.suspendSync();
    let result: ExecuteRestoreResult = { status: "done" };
    try {
        await withSyncLock(async () => {
            await persistProgress(session, "staging");
            await stageAll(session, onProgress);

            await persistProgress(session, "verify");
            onProgress?.({ done: 1, total: 1, label: "Verifying" });
            const verified = await verifyRestoreSession(session.sessionId);
            if (!verified.ok) {
                result = { status: "blocked", blockers: verified.blockers };
                return;
            }

            await persistProgress(session, "commit");
            onProgress?.({ done: 1, total: 1, label: "Committing" });
            await commitRestoreSession(session.sessionId);

            const leftover = await leftoverDirtyIds();
            if (leftover.length > 0) {
                await pullAndMerge();
                await savePersistedRestore(null);
                result = { status: "committed_dirty", leftoverDirty: leftover };
                return;
            }

            await persistProgress(session, "replace");
            onProgress?.({ done: 1, total: 1, label: "Replacing local copy" });
            // replaceLocal shares the mark-and-sweep block inside pullAndMerge — the one place of truth.
            await pullAndMerge({ replaceLocal: true });
            // The extra UI keys are not part of that sweep, so they go here.
            clearRestoreUiKeys();
            if (typeof window !== "undefined") {
                const { APP_EVENTS } = await import("$lib/core/constants/events");
                window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));
            }
            result = { status: "done" };
        });
        return result;
    } finally {
        syncStore.resumeSync();
        setRestoreBlockingUnload(false);
    }
}

export async function abortActiveRestore(sessionId: string): Promise<void> {
    await abortRestoreSession(sessionId);
    await savePersistedRestore(null);
    setRestoreBlockingUnload(false);
}

/** Test seams: a direct check for dirty entries. */
export async function listDirtyItemIds(): Promise<string[]> {
    return leftoverDirtyIds();
}

export type { LocalItem, RestoreMode, RestoreVerdict };
