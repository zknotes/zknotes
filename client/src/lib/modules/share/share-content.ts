import type { FilePayload, KdfParams } from "@zknotes/shared";
import type { ShareAttachmentWire } from "$lib/core/api/shares";
import { unwrapAndDecryptShareTask } from "$lib/core/workers/crypto-rpc";
import { isRasterImageMime } from "$lib/modules/files/sniff";
import { downloadShareAttachment } from "./share-download";
import { makeShareFileChip } from "./share-file-chip";
import { neutralizeInternalNoteLinks } from "./share-note-links";

/** The maximum size of a full inline image on the share page (with no thumbnail). */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

export type ShareViewCryptoContext = {
    shareId: string;
    fragmentKeyB64url: string;
    password?: string;
    kdfSaltB64?: string;
    kdfParams?: KdfParams;
    shareAuthKeyB64?: string;
};

function b64ToBytes(b64: string): Uint8Array {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function thumbnailBlobUrl(thumbnailB64: string): string {
    const bytes = b64ToBytes(thumbnailB64);
    let mime = "image/webp";
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) mime = "image/jpeg";
    const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return URL.createObjectURL(new Blob([buf], { type: mime }));
}

function replaceNode(el: Element, replacement: Element): void {
    el.parentNode?.replaceChild(replacement, el);
}

function makePlaceholder(text: string): HTMLParagraphElement {
    const p = document.createElement("p");
    p.className = "text-[var(--text-muted)] text-sm italic my-2";
    p.textContent = text;
    return p;
}

async function resolveShareFilePayload(
    att: ShareAttachmentWire,
    ctx: ShareViewCryptoContext,
): Promise<FilePayload | null> {
    try {
        const { data } = await unwrapAndDecryptShareTask<FilePayload>({
            shareId: ctx.shareId,
            sourceItemId: att.file_id,
            wrappedItemKey: b64ToBytes(att.wrapped_item_key),
            itemKeyNonce: b64ToBytes(att.item_key_nonce),
            encryptedPayload: b64ToBytes(att.encrypted_payload),
            payloadNonce: b64ToBytes(att.payload_nonce),
            fragmentKeyB64url: ctx.fragmentKeyB64url,
            password: ctx.password,
            kdfSaltB64: ctx.kdfSaltB64,
            kdfParams: ctx.kdfParams,
        });
        return data.kind === "file" ? data : null;
    } catch {
        return null;
    }
}

async function resolveImageSrc(
    att: ShareAttachmentWire,
    payload: FilePayload,
    ctx: ShareViewCryptoContext,
    blobUrls: string[],
): Promise<string | null> {
    // The full resolution for an inline view (a thumbnail is ≤320px — too narrow for the share view).
    if (isRasterImageMime(payload.mime) && payload.size <= MAX_INLINE_IMAGE_BYTES) {
        try {
            const { bytes, mime } = await downloadShareAttachment({
                shareId: ctx.shareId,
                attachment: att,
                fragmentKeyB64url: ctx.fragmentKeyB64url,
                password: ctx.password,
                kdfSaltB64: ctx.kdfSaltB64,
                kdfParams: ctx.kdfParams,
                shareAuthKeyB64: ctx.shareAuthKeyB64,
            });
            const buf = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
            const url = URL.createObjectURL(new Blob([buf], { type: mime }));
            blobUrls.push(url);
            return url;
        } catch {
            // fall back to the thumbnail below
        }
    }
    if (payload.thumbnail) {
        const url = thumbnailBlobUrl(payload.thumbnail);
        blobUrls.push(url);
        return url;
    }
    return null;
}

/**
 * Replaces the encFile <img data-file-id> nodes in the share HTML with real src URLs for the
 * attachments included in the link. With no attachments a placeholder is left in place.
 */
export async function hydrateShareNoteHtml(
    html: string,
    attachments: ShareAttachmentWire[],
    ctx: ShareViewCryptoContext,
): Promise<{ html: string; blobUrls: string[]; inlinedFileIds: string[] }> {
    const blobUrls: string[] = [];
    const inlinedFileIds: string[] = [];
    if (typeof document === "undefined" || !html.includes("data-file-id")) {
        return {
            html: neutralizeInternalNoteLinks(html),
            blobUrls,
            inlinedFileIds,
        };
    }

    const byId = new Map(attachments.map((a) => [a.file_id, a]));
    const doc = new DOMParser().parseFromString(`<div id="share-root">${html}</div>`, "text/html");
    const root = doc.getElementById("share-root");
    if (!root) return { html, blobUrls, inlinedFileIds };

    const imgs = [...root.querySelectorAll("img[data-file-id]")];
    for (const img of imgs) {
        const fileId = img.getAttribute("data-file-id");
        if (!fileId || fileId.startsWith("local:")) {
            replaceNode(img, makePlaceholder("[Image not available]"));
            continue;
        }

        const att = byId.get(fileId);
        if (!att) {
            replaceNode(
                img,
                makePlaceholder(
                    "[Image not included in this share link — enable Include attachments when sharing]",
                ),
            );
            continue;
        }

        const payload = await resolveShareFilePayload(att, ctx);
        if (!payload) {
            replaceNode(img, makePlaceholder("[Attachment unavailable]"));
            continue;
        }

        if (!isRasterImageMime(payload.mime)) {
            replaceNode(img, makeShareFileChip(fileId, payload.name || "File", payload.mime));
            inlinedFileIds.push(fileId);
            continue;
        }

        try {
            const src = await resolveImageSrc(att, payload, ctx, blobUrls);
            if (!src) {
                replaceNode(
                    img,
                    makePlaceholder(`[Image: ${payload.name || "image"} — see Attachments below]`),
                );
                continue;
            }
            img.setAttribute("src", src);
            img.removeAttribute("data-file-id");
            if (!img.getAttribute("alt")) img.setAttribute("alt", payload.name || "Image");
            inlinedFileIds.push(fileId);
        } catch {
            replaceNode(img, makePlaceholder("[Image could not be loaded]"));
        }
    }

    return {
        html: neutralizeInternalNoteLinks(root.innerHTML),
        blobUrls,
        inlinedFileIds,
    };
}
