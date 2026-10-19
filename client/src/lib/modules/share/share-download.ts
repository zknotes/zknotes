import { triggerAnchorDownload } from "$lib/core/utils/download-sink";
import type { FilePayload, KdfParams } from "@zknotes/shared";
import { FILE_LIMITS, viewProofB64FromFragmentKey } from "@zknotes/shared";
import type { ShareAttachmentWire } from "$lib/core/api/shares";
import { getShareChunk } from "$lib/core/api/shares";
import { fromBase64 } from "$lib/core/utils/base64";
import { decryptChunkWithKeyTask, unwrapAndDecryptShareTask } from "$lib/core/workers/crypto-rpc";

export type ShareDownloadProgress = {
    chunkIndex: number;
    totalChunks: number;
};

function b64ToBytes(b64: string): Uint8Array {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Downloads and decrypts a single share attachment (in memory, no streaming).
 */
export async function downloadShareAttachment(args: {
    shareId: string;
    attachment: ShareAttachmentWire;
    fragmentKeyB64url: string;
    password?: string;
    kdfSaltB64?: string;
    kdfParams?: KdfParams;
    shareAuthKeyB64?: string;
    onProgress?: (p: ShareDownloadProgress) => void;
}): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
    const { data: payload, itemKey } = await unwrapAndDecryptShareTask<FilePayload>({
        shareId: args.shareId,
        sourceItemId: args.attachment.file_id,
        wrappedItemKey: b64ToBytes(args.attachment.wrapped_item_key),
        itemKeyNonce: b64ToBytes(args.attachment.item_key_nonce),
        encryptedPayload: b64ToBytes(args.attachment.encrypted_payload),
        payloadNonce: b64ToBytes(args.attachment.payload_nonce),
        fragmentKeyB64url: args.fragmentKeyB64url,
        password: args.password,
        kdfSaltB64: args.kdfSaltB64,
        kdfParams: args.kdfParams,
        retainItemKey: true,
    });

    if (!itemKey || payload.kind !== "file") {
        throw new Error("Invalid attachment");
    }
    // The free MAX_FILE_SIZE is a plan's upload limit; a share download has to allow the paid
    // cap (the anti-DoS ceiling), or else paid attachments over 50 MB fail on the client.
    if (payload.size > FILE_LIMITS.MAX_FILE_SIZE_CAP) {
        throw new Error("File exceeds maximum download size");
    }

    const { chunkSetId, chunks } = payload;
    const totalChunks = chunks.length;
    // Derived once for the whole file rather than per chunk: the server wants it on every request,
    // and it is the same value each time.
    const viewProofB64 = viewProofB64FromFragmentKey(args.fragmentKeyB64url);
    const parts: Uint8Array[] = [];
    let totalLen = 0;

    try {
        for (let i = 0; i < totalChunks; i++) {
            args.onProgress?.({ chunkIndex: i, totalChunks });
            const nonce = fromBase64(chunks[i].nonce);
            const chunkRes = await getShareChunk(
                args.shareId,
                args.attachment.file_id,
                i,
                args.shareAuthKeyB64,
                viewProofB64,
            );
            if ("status" in chunkRes && chunkRes.status === "unavailable") {
                throw new Error("Attachment is no longer available");
            }
            const cipherRes = await fetch((chunkRes as { url: string }).url, {
                cache: "no-store",
            });
            if (!cipherRes.ok) throw new Error("Failed to fetch attachment chunk");
            const ciphertext = new Uint8Array(await cipherRes.arrayBuffer());
            const plain = await decryptChunkWithKeyTask(
                itemKey,
                chunkSetId,
                i,
                totalChunks,
                ciphertext,
                nonce,
            );
            parts.push(plain);
            totalLen += plain.byteLength;
        }
    } finally {
        itemKey.fill(0);
    }

    const bytes = new Uint8Array(totalLen);
    let off = 0;
    for (const p of parts) {
        bytes.set(p, off);
        off += p.byteLength;
    }

    return {
        bytes,
        name: payload.name || "attachment",
        mime: payload.mime || "application/octet-stream",
    };
}

/** Triggers the browser download of a decrypted share attachment. */
export function saveShareAttachmentFile(bytes: Uint8Array, name: string, mime: string): void {
    const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
    triggerAnchorDownload(url, name);
    // A synchronous revoke can cut the download short (Firefox/Safari) — delay it until the download has started.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
