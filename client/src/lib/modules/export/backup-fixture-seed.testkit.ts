// Seeds IDB + file-chunks from the backup-fixture plaintext, using the in-process crypto state.
// For the tests only — it is not part of the production import path.

import {
    buildChunkAad,
    buildItemKeyAad,
    buildPayloadAad,
    encryptChunk,
    encryptItemKey,
    encryptPayload,
    generateItemKey,
} from "@zknotes/shared";
import { getDB, type LocalItem } from "$lib/core/db";
import { putLocalChunk } from "$lib/core/db/file-chunks";
import { toBase64 } from "$lib/core/utils/base64";
import {
    buildFixtureVault,
    FIXTURE_IDS,
    FIXTURE_MULTI_CHUNK_SIZE,
    type FixtureVault,
} from "./backup-fixture";
import type { InProcessCryptoState } from "./backup-test-crypto.testkit";
import type { BackupFile, BackupFolder, BackupNote } from "./full-backup";

function wrapAndCache(
    state: InProcessCryptoState,
    itemId: string,
    ik: Uint8Array,
): { encrypted_item_key: string; item_key_nonce: string } {
    state.itemKeys.set(itemId, ik);
    const wrapped = encryptItemKey(ik, state.vaultKey, buildItemKeyAad(itemId));
    return {
        encrypted_item_key: toBase64(wrapped.ciphertext),
        item_key_nonce: toBase64(wrapped.nonce),
    };
}

async function seedNoteOrFolder(
    state: InProcessCryptoState,
    item: BackupNote | BackupFolder,
    versionOverride?: number,
): Promise<void> {
    const version = versionOverride ?? item.version;
    const payload: Record<string, unknown> = { title: item.title };
    if (item.type === "note") payload.content = item.content ?? "";
    if (item.color) payload.color = item.color;
    if (item.icon) payload.icon = item.icon;
    if (item.starred) payload.starred = true;
    if (item.type === "note" && item.contentTitle !== undefined) {
        payload.contentTitle = item.contentTitle;
    }
    if (item.type === "note" && item.outlineVisible !== undefined) {
        payload.outlineVisible = item.outlineVisible;
    }

    const ik = generateItemKey();
    const keys = wrapAndCache(state, item.id, ik);
    const { ciphertext, nonce } = encryptPayload(payload, ik, buildPayloadAad(item.id, version));

    const row: LocalItem = {
        id: item.id,
        parent_id: item.parent_id,
        type: item.type,
        encrypted_payload: toBase64(ciphertext),
        payload_nonce: toBase64(nonce),
        encrypted_item_key: keys.encrypted_item_key,
        item_key_nonce: keys.item_key_nonce,
        sort_order: item.sort_order,
        version,
        dirty: false,
        localRev: 0,
        created_at: item.created_at,
        updated_at: item.updated_at,
    };
    const db = await getDB();
    await db.put("items", row);
}

async function seedFile(
    state: InProcessCryptoState,
    meta: BackupFile,
    bytes: Uint8Array,
    opts?: { version?: number; multiChunk?: boolean },
): Promise<void> {
    const version = opts?.version ?? meta.version;
    const ik = generateItemKey();
    const keys = wrapAndCache(state, meta.id, ik);

    const multi = opts?.multiChunk ?? meta.id === FIXTURE_IDS.fileMulti;
    const chunkSize = multi ? FIXTURE_MULTI_CHUNK_SIZE : Math.max(bytes.byteLength, 1);
    const totalChunks =
        bytes.byteLength === 0 ? 1 : multi ? Math.ceil(bytes.byteLength / chunkSize) : 1;
    const chunkSetId = `cs-${meta.id}`;

    const chunks: Array<{ nonce: string; hash: string; size: number }> = [];
    for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const plain =
            bytes.byteLength === 0
                ? new Uint8Array(0)
                : bytes.subarray(start, Math.min(start + chunkSize, bytes.byteLength));
        const { ciphertext, nonce } = encryptChunk(
            plain,
            ik,
            buildChunkAad(chunkSetId, i, totalChunks),
        );
        await putLocalChunk({
            key: `${chunkSetId}:${i}`,
            chunkSetId,
            index: i,
            ciphertext,
            nonce,
            storedAt: Date.now(),
        });
        // loadChunk's verify expects the real SHA-256 of the ciphertext, not a placeholder.
        const hashDigest = new Uint8Array(
            await crypto.subtle.digest("SHA-256", ciphertext as BufferSource),
        );
        chunks.push({
            nonce: toBase64(nonce),
            hash: toBase64(hashDigest),
            size: ciphertext.byteLength,
        });
    }

    const payload: Record<string, unknown> = {
        kind: "file",
        chunkSetId,
        name: meta.name,
        mime: meta.mime,
        size: bytes.byteLength,
        chunkSize,
        chunks,
        ...(meta.description ? { description: meta.description } : {}),
    };
    const { ciphertext, nonce } = encryptPayload(payload, ik, buildPayloadAad(meta.id, version));

    const row: LocalItem = {
        id: meta.id,
        parent_id: meta.parent_id,
        type: "file",
        encrypted_payload: toBase64(ciphertext),
        payload_nonce: toBase64(nonce),
        encrypted_item_key: keys.encrypted_item_key,
        item_key_nonce: keys.item_key_nonce,
        chunk_set_id: chunkSetId,
        chunk_count: totalChunks,
        ciphertext_size: chunks.reduce((n, c) => n + c.size, 0),
        sort_order: meta.sort_order,
        version,
        dirty: false,
        localRev: 0,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
    };
    const db = await getDB();
    await db.put("items", row);
}

/**
 * Writes the whole fixture vault into IDB (items + file-chunks) under the given crypto state.
 * `versionForAll` forces the same version on every row (5, say, for the overwrite regression).
 */
export async function seedFixtureVault(
    state: InProcessCryptoState,
    vault: FixtureVault = buildFixtureVault(),
    opts?: { versionForAll?: number },
): Promise<void> {
    for (const item of vault.items) {
        if (item.type === "note" || item.type === "folder") {
            await seedNoteOrFolder(state, item, opts?.versionForAll);
        } else if (item.type === "file") {
            const bytes = vault.fileMap.get(item.id);
            if (!bytes) throw new Error(`fixture missing bytes for ${item.id}`);
            await seedFile(state, item, bytes, {
                version: opts?.versionForAll,
                multiChunk: item.id === FIXTURE_IDS.fileMulti,
            });
        }
    }
}

/** Deletes items + file-chunks + mutation-queue (between the export and import phases). */
export async function clearVaultStores(): Promise<void> {
    const db = await getDB();
    await db.clear("items");
    await db.clear("mutation-queue");
    await db.clear("file-chunks");
}
