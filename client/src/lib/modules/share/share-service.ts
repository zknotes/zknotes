import { viewProofB64FromFragmentKey } from "@zknotes/shared";
import { uuidv7 } from "uuidv7";
import { createShare, listShares, revokeShare, type ShareListEntry } from "$lib/core/api/shares";
import { bytesToB64 } from "$lib/core/utils/b64url";
import { wrapItemKeyForShareTask } from "$lib/core/workers/crypto-rpc";

export type ShareLinkType = "standard" | "expiry" | "burn";

const TTL_OPTIONS = [
    { label: "1 hour", sec: 3600 },
    { label: "24 hours", sec: 24 * 3600 },
    { label: "7 days", sec: 7 * 24 * 3600 },
] as const;

/**
 * The TTLs on offer. `maxSec` is **a concrete limit from the server** (`GET /me/storage`) rather than
 * something derived from a plan — the client no longer knows plans exist.
 *
 * A `0` (the server has not answered yet) means feature-off: an empty list is better than an offer the
 * server will refuse. The same choice as with the file-size limit.
 */
export function shareTtlOptions(maxSec: number) {
    return TTL_OPTIONS.filter((o) => o.sec <= maxSec);
}

export function isShareListEntryActive(row: ShareListEntry): boolean {
    if (row.revoked_at) return false;
    if (row.source_deleted) return false;
    if (row.expires_at != null && row.expires_at * 1000 < Date.now()) return false;
    return true;
}

export async function getActiveShareForNote(noteId: string): Promise<ShareListEntry | null> {
    const shares = await listShares();
    return shares.find((s) => s.source_item_id === noteId && isShareListEntryActive(s)) ?? null;
}

export function formatShareError(code: string): string {
    switch (code) {
        case "share_exists":
            return "This note already has an active share link. Revoke it in Settings → Shared links, or use Replace link.";
        case "too_many_shares":
            return "You reached the maximum number of active share links.";
        case "invalid_attachment":
            return "One or more attachments could not be shared.";
        default:
            return code || "Failed to create link";
    }
}

export async function createShareLink(opts: {
    sourceItemId: string;
    linkType: ShareLinkType;
    expiresInSec?: number;
    password?: string;
    includeAttachments?: boolean;
    attachmentFileIds?: string[];
}): Promise<{ url: string; shareId: string; fullUrl: string }> {
    const shareId = uuidv7();
    const password = opts.password?.trim() || undefined;
    const wrapped = await wrapItemKeyForShareTask(shareId, opts.sourceItemId, { password });

    const attachments: Array<{
        file_id: string;
        wrapped_item_key: string;
        item_key_nonce: string;
    }> = [];

    if (opts.includeAttachments && opts.attachmentFileIds?.length) {
        for (const fileId of opts.attachmentFileIds) {
            const fileWrap = await wrapItemKeyForShareTask(shareId, fileId, {
                password,
                fragmentKeyB64url: wrapped.fragmentKeyB64url,
                kdfSaltB64: wrapped.kdfSaltB64,
                kdfParams: wrapped.kdfParams,
            });
            attachments.push({
                file_id: fileId,
                wrapped_item_key: bytesToB64(fileWrap.wrappedItemKey),
                item_key_nonce: bytesToB64(fileWrap.itemKeyNonce),
            });
        }
    }

    let expiresInSec: number | null = null;
    let maxViews: 1 | null = null;
    if (opts.linkType === "expiry" && opts.expiresInSec) {
        expiresInSec = opts.expiresInSec;
    } else if (opts.linkType === "burn") {
        maxViews = 1;
    }

    await createShare({
        id: shareId,
        source_item_id: opts.sourceItemId,
        wrapped_item_key: bytesToB64(wrapped.wrappedItemKey),
        item_key_nonce: bytesToB64(wrapped.itemKeyNonce),
        expires_in_sec: expiresInSec,
        max_views: maxViews,
        // Proof of possession of the #k= fragment key — the server burns only on a valid proof.
        view_proof: viewProofB64FromFragmentKey(wrapped.fragmentKeyB64url),
        share_auth_key: wrapped.shareAuthKeyB64 ?? null,
        share_kdf_salt: wrapped.kdfSaltB64 ?? null,
        share_kdf_params: wrapped.kdfParams ?? null,
        attachments: attachments.length ? attachments : undefined,
    });

    const path = `/s/${shareId}#k=${wrapped.fragmentKeyB64url}`;
    const fullUrl = `${window.location.origin}${path}`;
    return { url: path, shareId, fullUrl };
}

export { listShares, revokeShare };
