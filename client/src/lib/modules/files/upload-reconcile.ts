// Reconciling the manifest with the batched S3 status.
import type { ManifestChunkEntry } from "$lib/core/db";
import { loadUploadChunk } from "./upload-chunk-store";

export interface ReconcileResult {
    manifest: Record<number, ManifestChunkEntry>;
    confirmedIndices: Set<number>;
    fatalIntegrity: boolean;
}

/**
 * Reconciles the pending manifest against the `present_indices` from GET .../status.
 * It returns the updated manifest and the set of confirmed indices.
 */
export async function reconcileManifestWithStatus(
    pendingLocalId: string,
    manifest: Record<number, ManifestChunkEntry>,
    presentIndices: number[],
): Promise<ReconcileResult> {
    const updated: Record<number, ManifestChunkEntry> = { ...manifest };
    const confirmedIndices = new Set<number>();
    const presentSet = new Set(presentIndices);

    for (const i of presentIndices) {
        const entry = updated[i];
        if (entry?.local_state === "confirmed") {
            confirmedIndices.add(i);
            continue;
        }
        if (entry?.nonce) {
            updated[i] = { ...entry, local_state: "confirmed" };
            confirmedIndices.add(i);
            continue;
        }

        const staged = await loadUploadChunk(pendingLocalId, i);
        if (staged) {
            updated[i] = {
                nonce: staged.nonce,
                hash: staged.hash,
                size: staged.size,
                local_state: "confirmed",
            };
            confirmedIndices.add(i);
            continue;
        }

        return { manifest: updated, confirmedIndices, fatalIntegrity: true };
    }

    // Confirmed in the manifest, but the index is NOT on S3 → demote it to persisted (a re-PUT).
    // Before: we kept it confirmed → uploadChunks skipped it → a finalize 409 loop.
    for (const [idxStr, entry] of Object.entries(updated)) {
        const i = Number(idxStr);
        if (entry.local_state !== "confirmed") continue;
        if (presentSet.has(i)) {
            confirmedIndices.add(i);
        } else {
            updated[i] = { ...entry, local_state: "persisted" };
        }
    }

    return { manifest: updated, confirmedIndices, fatalIntegrity: false };
}

export function allChunksPresentOnS3(presentIndices: number[], totalChunks: number): boolean {
    if (presentIndices.length < totalChunks) return false;
    const set = new Set(presentIndices);
    for (let i = 0; i < totalChunks; i++) {
        if (!set.has(i)) return false;
    }
    return true;
}
