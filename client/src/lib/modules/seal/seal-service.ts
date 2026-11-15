/**
 * Sealing a file: hash it, write the manifest, take an OpenTimestamps proof over the manifest, and
 * keep the result encrypted on the server. Later, upgrade the proof once a calendar has committed it
 * to a block.
 *
 * What leaves the device: the 32-byte commitment `sha256(sha256(manifest) ‖ nonce)` (relayed by our
 * server to the calendars) and the encrypted seal record. The file, its hash, the manifest and the
 * nonce stay here; the plaintext of the file never leaves the crypto worker.
 */
import {
    ApiError,
    createSeal,
    deleteSeal,
    getSealBlock,
    listSeals,
    putSeal,
    upgradeSeal,
} from "$lib/core/api";
import type { SealWire } from "@zknotes/shared";
import { getDB } from "$lib/core/db";
import { loadChunk } from "$lib/core/files/chunk-loader";
import { fromBase64, toBase64 } from "$lib/core/utils/base64";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";
import {
    sealDecryptRecordTask,
    sealEncryptRecordTask,
    sealHashChunkTask,
    sealHashFinishTask,
    sealHashStartTask,
} from "$lib/core/workers/crypto-rpc";
import type { FilePayload } from "@zknotes/shared";
import { uuidv7 } from "uuidv7";
import {
    decodeManifest,
    encodeManifest,
    manifestDigest,
    newManifest,
    type SealManifest,
} from "./manifest";
import {
    type BitcoinAnchor,
    bitcoinAnchors,
    bitcoinHeights,
    createSealTree,
    fromHex,
    mergeAt,
    OP,
    parseDetached,
    pendingAttestations,
    serializeDetached,
    toHex,
} from "./ots-protocol";

/** What the encrypted record holds. Everything a certificate needs, nothing the server may read. */
export type SealRecord = {
    v: 1;
    /** The chunk set this seal vouches for — trusted over the server's column of the same name. */
    chunk_set_id: string;
    /** The file's name when it was sealed, for the export. Not part of the manifest. */
    file_name: string;
    /** The canonical manifest text, exactly the bytes the proof commits to. */
    manifest: string;
    /** The detached `.ots` proof over the manifest, base64. */
    proof: string;
    /** When this device first saw the proof reach a block (its own clock); absent while pending. */
    confirmed_at?: string;
    /**
     * When the earliest block the proof reaches was mined, from a header this device checked
     * (`block-header.ts`). The tighter "existed before"; absent until a header has passed.
     */
    block_time?: string;
    block_height?: number;
};

/** The best "existed before" this device can state for a confirmed seal, and where it came from. */
export function existedBefore(
    record: SealRecord,
):
    | { iso: string; source: "block"; height: number }
    | { iso: string; source: "confirmation" }
    | null {
    if (record.block_time && record.block_height !== undefined) {
        return { iso: record.block_time, source: "block", height: record.block_height };
    }
    return record.confirmed_at ? { iso: record.confirmed_at, source: "confirmation" } : null;
}

export type SealView = {
    id: string;
    state: "pending" | "confirmed";
    createdAt: number;
    record: SealRecord;
    manifest: SealManifest;
    /** Block heights the proof reaches; empty while pending. */
    blocks: number[];
    /**
     * The calendars' Bitcoin transactions the proof passes through, earliest block first; derived
     * from the proof, never stored. Empty while pending, or if a calendar's transaction is not
     * recognized (the certificate then names only the block).
     */
    anchors: BitcoinAnchor[];
};

export class SealError extends Error {
    constructor(
        readonly code:
            | "disabled"
            | "limit"
            | "calendars_unavailable"
            | "not_ready"
            | "quota"
            | "failed",
        message: string,
        readonly limit?: number,
    ) {
        super(message);
        this.name = "SealError";
    }
}

/** A row the client opened but never completed (the tab closed between the two calls). */
const INCOMPLETE_ROW_TTL_SEC = 15 * 60;

function serverError(err: unknown): string | undefined {
    return err instanceof ApiError && typeof err.body?.error === "string"
        ? err.body.error
        : undefined;
}

async function readyFilePayload(itemId: string, allowTrashed = false): Promise<FilePayload> {
    const db = await getDB();
    const item = await db.get("items", itemId);
    const state = item ? FileLifecycle.stateOf(item) : "DELETED";
    if (!item || !(state === "READY" || (allowTrashed && state === "TRASHED"))) {
        throw new SealError("not_ready", "This file is not available to seal.");
    }
    const { decryptItemPayload } = await import("$lib/core/crypto/item-codec");
    const payload = await decryptItemPayload<FilePayload>(item);
    if (payload.kind !== "file" || !payload.chunkSetId) {
        throw new SealError("not_ready", "This item is not a file.");
    }
    return payload;
}

/** SHA-256 of the file's plaintext, computed in the crypto worker one chunk at a time. */
async function hashFile(
    itemId: string,
    payload: FilePayload,
    onProgress?: (done: number, total: number) => void,
): Promise<{ sha256Hex: string; byteLength: number }> {
    const sessionId = crypto.randomUUID();
    const total = payload.chunks.length;
    await sealHashStartTask(sessionId);
    for (let i = 0; i < total; i++) {
        onProgress?.(i, total);
        const ref = payload.chunks[i] as (typeof payload.chunks)[number];
        const nonce = fromBase64(ref.nonce);
        // A one-shot read: sealing a large file must not fill or evict the offline cache.
        const ciphertext = await loadChunk(payload.chunkSetId, i, nonce, ref.hash, {
            persist: false,
        });
        await sealHashChunkTask({
            sessionId,
            itemId,
            chunkSetId: payload.chunkSetId,
            chunkIndex: i,
            totalChunks: total,
            ciphertext,
            nonce,
        });
    }
    onProgress?.(total, total);
    return sealHashFinishTask(sessionId);
}

async function storeRecord(id: string, state: SealView["state"], record: SealRecord) {
    const c = await sealEncryptRecordTask(id, record);
    try {
        await putSeal(id, {
            state,
            encrypted_record: toBase64(c.encryptedRecord),
            record_nonce: toBase64(c.recordNonce),
            encrypted_seal_key: toBase64(c.encryptedSealKey),
            seal_key_nonce: toBase64(c.sealKeyNonce),
        });
    } catch (err) {
        if (serverError(err) === "quota_exceeded") {
            throw new SealError("quota", "Not enough storage left to keep the seal.");
        }
        throw err;
    }
}

/**
 * Seals the file's current content. Resolves once the proof is pending at one or more calendars;
 * it becomes a complete proof hours later, through `upgradePendingSeals`.
 */
export async function sealFile(
    itemId: string,
    onProgress?: (phase: "hashing" | "stamping" | "saving", done?: number, total?: number) => void,
): Promise<SealView> {
    const payload = await readyFilePayload(itemId);
    const { sha256Hex, byteLength } = await hashFile(itemId, payload, (d, t) =>
        onProgress?.("hashing", d, t),
    );
    const manifest = newManifest({
        contentSha256: sha256Hex,
        contentType: payload.mime,
        byteLength,
    });
    const manifestBytes = encodeManifest(manifest);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const { root, commitment } = await createSealTree(await manifestDigest(manifestBytes), nonce);

    onProgress?.("stamping");
    const id = uuidv7();
    let replies: Awaited<ReturnType<typeof createSeal>>["replies"];
    try {
        ({ replies } = await createSeal({
            id,
            chunk_set_id: payload.chunkSetId,
            commitment: toHex(commitment.msg),
        }));
    } catch (err) {
        const code = serverError(err);
        if (code === "seal_limit") {
            const limit = (err as ApiError).body?.limit;
            throw new SealError(
                "limit",
                "You have reached today's limit for seals.",
                typeof limit === "number" ? limit : undefined,
            );
        }
        if (code === "seals_disabled") throw new SealError("disabled", "Sealing is turned off.");
        if (code === "calendars_unavailable") {
            throw new SealError(
                "calendars_unavailable",
                "No timestamp service answered. Nothing was sealed; try again later.",
            );
        }
        if (code === "not_found") throw new SealError("not_ready", "This file is not available.");
        throw err;
    }

    let merged = 0;
    for (const reply of replies) {
        if (!reply.ok) continue;
        try {
            await mergeAt(root, commitment.msg, fromBase64(reply.body));
            merged++;
        } catch {
            // A malformed reply from one calendar does not spoil the others.
        }
    }
    if (merged === 0) {
        await deleteSeal(id).catch(() => {});
        throw new SealError(
            "calendars_unavailable",
            "No timestamp service gave a usable answer. Nothing was sealed; try again later.",
        );
    }

    onProgress?.("saving");
    const record: SealRecord = {
        v: 1,
        chunk_set_id: payload.chunkSetId,
        file_name: payload.name,
        manifest: new TextDecoder().decode(manifestBytes),
        proof: toBase64(serializeDetached({ hashOp: OP.sha256, timestamp: root })),
    };
    await storeRecord(id, "pending", record);
    return {
        id,
        state: "pending",
        createdAt: Math.floor(Date.now() / 1000),
        record,
        manifest,
        blocks: [],
        anchors: [],
    };
}

async function decryptRow(row: SealWire): Promise<SealView | null> {
    if (
        !row.encrypted_record ||
        !row.record_nonce ||
        !row.encrypted_seal_key ||
        !row.seal_key_nonce
    ) {
        return null;
    }
    try {
        const record = await sealDecryptRecordTask<SealRecord>(row.id, {
            encryptedRecord: fromBase64(row.encrypted_record),
            recordNonce: fromBase64(row.record_nonce),
            encryptedSealKey: fromBase64(row.encrypted_seal_key),
            sealKeyNonce: fromBase64(row.seal_key_nonce),
        });
        const manifest = decodeManifest(new TextEncoder().encode(record.manifest));
        const proof = await parseDetached(fromBase64(record.proof));
        return {
            id: row.id,
            state: row.state,
            createdAt: row.created_at,
            record,
            manifest,
            blocks: bitcoinHeights(proof.timestamp),
            anchors: bitcoinAnchors(proof.timestamp),
        };
    } catch {
        // A record this vault cannot open (or one that does not parse) is not shown as a proof.
        return null;
    }
}

export type SealOverview = { seals: SealView[]; perDay: number; usedToday: number };

/**
 * Every readable seal of the user, newest first. Rows left half-made by a closed tab are removed
 * once they are clearly abandoned.
 */
export async function loadSeals(): Promise<SealOverview> {
    const res = await listSeals();
    const now = Math.floor(Date.now() / 1000);
    const views: SealView[] = [];
    for (const row of res.seals) {
        if (!row.encrypted_record) {
            if (now - row.created_at > INCOMPLETE_ROW_TTL_SEC)
                void deleteSeal(row.id).catch(() => {});
            continue;
        }
        const view = await decryptRow(row);
        if (view) views.push(view);
    }
    return { seals: views, perDay: res.limit.per_day, usedToday: res.limit.used_today };
}

/**
 * The chunk set a file's current content lives in, from its encrypted payload. A trashed file
 * still has one (it can be restored); null once it is gone.
 */
export async function chunkSetOfFile(itemId: string): Promise<string | null> {
    try {
        return (await readyFilePayload(itemId, true)).chunkSetId;
    } catch {
        return null;
    }
}

// The guard runs once per file of a bulk delete; one listing serves the whole burst.
let recentOverview: { at: number; value: Promise<SealOverview> } | null = null;
const OVERVIEW_REUSE_MS = 30_000;

/** How many seals vouch for the file's current content — the guard before replace or purge. */
export async function sealCountOfFile(itemId: string): Promise<number> {
    const chunkSetId = await chunkSetOfFile(itemId);
    if (!chunkSetId) return 0;
    if (!recentOverview || Date.now() - recentOverview.at > OVERVIEW_REUSE_MS) {
        recentOverview = { at: Date.now(), value: loadSeals() };
        recentOverview.value.catch(() => {
            recentOverview = null;
        });
    }
    const { seals } = await recentOverview.value;
    return sealsForChunkSet(seals, chunkSetId).length;
}

/**
 * A marker per file whose current content is sealed: done once any seal of it is confirmed,
 * otherwise in progress. Files are matched by the chunk set id from their encrypted payload.
 */
export async function sealMarkers(
    files: ReadonlyArray<{ id: string; chunkSetId?: string }>,
): Promise<Map<string, { label: string; done: boolean }>> {
    const { seals } = await loadSeals();
    const byChunkSet = new Map<string, boolean>();
    for (const s of seals) {
        const done = s.state === "confirmed";
        byChunkSet.set(
            s.record.chunk_set_id,
            (byChunkSet.get(s.record.chunk_set_id) ?? false) || done,
        );
    }
    const out = new Map<string, { label: string; done: boolean }>();
    for (const f of files) {
        const done = f.chunkSetId ? byChunkSet.get(f.chunkSetId) : undefined;
        if (done !== undefined) out.set(f.id, { label: done ? "Sealed" : "Seal pending", done });
    }
    return out;
}

/** The seals of one chunk set, by the chunk set id inside each record (never the server's column). */
export function sealsForChunkSet(all: readonly SealView[], chunkSetId: string): SealView[] {
    return all.filter((s) => s.record.chunk_set_id === chunkSetId);
}

/**
 * Asks the calendars whether a pending seal has reached a block, and stores the completed proof if
 * so. Returns the updated view (unchanged when it is still pending).
 */
export async function upgradeOne(view: SealView): Promise<SealView> {
    if (view.state === "confirmed") return view;
    const proof = await parseDetached(fromBase64(view.record.proof));
    const pending = pendingAttestations(proof.timestamp);
    if (pending.length === 0) return view;
    const { results } = await upgradeSeal(view.id, {
        attestations: pending.map((p) => ({ calendar: p.uri, message: toHex(p.msg) })),
    });
    let changed = false;
    for (const r of results) {
        if (r.status !== "confirmed") continue;
        try {
            await mergeAt(proof.timestamp, fromHex(r.message), fromBase64(r.body));
            changed = true;
        } catch {
            // One bad answer does not spoil the others.
        }
    }
    const blocks = bitcoinHeights(proof.timestamp);
    if (!changed || blocks.length === 0) return view;
    const record: SealRecord = {
        ...view.record,
        proof: toBase64(serializeDetached(proof)),
        confirmed_at: new Date().toISOString(),
    };
    await storeRecord(view.id, "confirmed", record);
    const confirmed: SealView = {
        ...view,
        state: "confirmed",
        record,
        blocks,
        anchors: bitcoinAnchors(proof.timestamp),
    };
    try {
        return await resolveBlockTime(confirmed);
    } catch {
        return confirmed;
    }
}

/**
 * Fills in when the anchoring block was mined: the header of each block the proof reaches is
 * fetched through the server and checked here (proof of work at mainnet-scale difficulty, Merkle
 * root equal to the proof's own message) before its time is believed. The earliest checked block
 * wins. Without a block source, or with no header that passes, the view is returned unchanged and
 * the confirmation time stands in.
 */
export async function resolveBlockTime(view: SealView): Promise<SealView> {
    if (view.state !== "confirmed" || view.record.block_time) return view;
    const proof = await parseDetached(fromBase64(view.record.proof));
    const { checkBlockHeader } = await import("./block-header");
    const headers = new Map<number, Promise<string | null>>();
    let best: { time: number; height: number } | null = null;
    for (const { msg, attestation } of proof.timestamp.allAttestations()) {
        if (attestation.kind !== "bitcoin") continue;
        const h = attestation.height;
        if (!headers.has(h)) {
            headers.set(
                h,
                getSealBlock(h).then(
                    (r) => (r.height === h ? r.header : null),
                    () => null,
                ),
            );
        }
        const header = await headers.get(h);
        if (!header) continue;
        try {
            const time = await checkBlockHeader(header, msg);
            if (!best || time < best.time) best = { time, height: h };
        } catch {
            // A header that does not check out is ignored, never shown.
        }
    }
    if (!best) return view;
    const record: SealRecord = {
        ...view.record,
        block_time: new Date(best.time * 1000).toISOString(),
        block_height: best.height,
    };
    await storeRecord(view.id, "confirmed", record);
    return { ...view, record };
}

/**
 * Upgrades every pending seal, and fills in the block time of confirmed ones that lack it; a
 * failure of one does not stop the rest.
 */
export async function upgradePendingSeals(views: readonly SealView[]): Promise<SealView[]> {
    const out: SealView[] = [];
    for (const v of views) {
        try {
            out.push(v.state === "pending" ? await upgradeOne(v) : await resolveBlockTime(v));
        } catch {
            out.push(v);
        }
    }
    return out;
}

export async function removeSeal(id: string): Promise<void> {
    await deleteSeal(id);
}
