import type { CreateShareRequest, KdfParams } from "@zknotes/shared";
import { API_BASE, apiFetch } from "./client";

export type ShareListEntry = {
    id: string;
    source_item_id: string;
    created_at: number;
    expires_at: number | null;
    revoked_at: number | null;
    last_viewed_at: number | null;
    view_count: number;
    max_views: number | null;
    needs_password: boolean;
    source_deleted: boolean;
    attachment_count: number;
};

export type ShareMetaResponse =
    | { status: "unavailable" }
    | {
          needs_password: boolean;
          share_kdf_salt?: string | null;
          share_kdf_params?: KdfParams;
          expires_at: number | null;
          max_views: number | null;
          has_attachments?: boolean;
      };

export type ShareAttachmentWire = {
    file_id: string;
    wrapped_item_key: string;
    item_key_nonce: string;
    encrypted_payload: string;
    payload_nonce: string;
    chunk_set_id: string;
    chunk_count: number;
};

export type ShareViewResponse =
    | { status: "unavailable" }
    | {
          encrypted_payload: string;
          payload_nonce: string;
          wrapped_item_key: string;
          item_key_nonce: string;
          source_item_id: string;
          attachments: ShareAttachmentWire[];
          /** Present only when this view consumed a burn link — how many seconds the attachments keep working. */
          burn_download_grace_sec?: number;
      };

export function createShare(body: CreateShareRequest) {
    return apiFetch<Record<string, unknown>>("/shares", {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export function listShares() {
    return apiFetch<ShareListEntry[]>("/shares");
}

export function revokeShare(id: string) {
    return apiFetch<Record<string, unknown>>(`/shares/${id}`, { method: "DELETE" });
}

export function getShareMeta(id: string) {
    return apiFetch<ShareMetaResponse>(`/shares/${id}`);
}

export function viewShare(id: string, opts?: { shareAuthKeyB64?: string; viewProofB64?: string }) {
    const body: Record<string, string> = {};
    if (opts?.viewProofB64) body.view_proof = opts.viewProofB64;
    if (opts?.shareAuthKeyB64) body.share_auth_key = opts.shareAuthKeyB64;
    return apiFetch<ShareViewResponse>(`/shares/${id}/view`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

export async function getShareChunk(
    shareId: string,
    fileId: string,
    index: number,
    shareAuthKeyB64?: string,
    viewProofB64?: string,
): Promise<{ url: string } | { status: "unavailable" }> {
    // Both verifiers go in the request body, the same as POST /shares/:id/view: a query string and
    // custom headers both end up in access and proxy logs, a body does not. `viewProofB64` proves
    // possession of the `#k=` fragment key without sending it, so that knowing the link's address
    // alone buys nothing.
    const body: Record<string, string> = {};
    if (viewProofB64) body.view_proof = viewProofB64;
    if (shareAuthKeyB64) body.share_auth_key = shareAuthKeyB64;
    const res = await fetch(`${API_BASE}/shares/${shareId}/chunks/${fileId}/${index}`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    // A 5xx, an HTML error page or an empty answer is "unavailable", not a SyntaxError in the
    // media stream's pull().
    if (!res.ok) return { status: "unavailable" };
    const data = (await res.json().catch(() => ({}))) as { url?: string; status?: string };
    if (data.status === "unavailable" || !data.url) {
        return { status: "unavailable" };
    }
    return { url: data.url };
}
