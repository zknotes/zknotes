// What a backup or an HTML export has to download before it can write anything: the live files
// whose chunks are not all on this device. A file row carries its chunk refs in the
// clear (`chunk_set_id`, `chunk_count`, `ciphertext_size`), so the count needs no
// decryption; only a row without them falls back to its payload.
import { FILE_LIMITS } from "@zknotes/shared";
import type { LocalItem } from "$lib/core/db";
import { hasAllChunks } from "$lib/core/db/file-chunks";
import { FileLifecycle } from "$lib/core/utils/file-lifecycle";
import { shouldAutoDownload } from "$lib/modules/files/sync-settings";
import { loadLiveItems } from "./utils";

export interface MissingFiles {
    count: number;
    /** The ciphertext still to download — the size of the transfer, not of the plaintext. */
    bytes: number;
    /** The plaintext size of the largest of these files — what the auto-download policy compares. */
    largest: number;
}

export interface MissingFilesReport {
    /** Every live file: what a backup (or an export with attachments) downloads. */
    all: MissingFiles;
    /**
     * Only the files embedded in a live note — what an HTML export without standalone attachments
     * still downloads, since its pages need their images. A READY file lives in the note that embeds
     * it (a file belongs to exactly one note), so the owner note stands for the embed.
     */
    embedded: MissingFiles;
}

interface ChunkRefs {
    chunkSetId: string;
    count: number;
    bytes: number;
    plainBytes: number;
}

async function chunkRefs(item: LocalItem): Promise<ChunkRefs | null> {
    if (item.chunk_set_id && item.chunk_count != null) {
        const bytes = item.ciphertext_size ?? 0;
        return {
            chunkSetId: item.chunk_set_id,
            count: item.chunk_count,
            bytes,
            // Every chunk adds one AEAD tag, so this is exact.
            plainBytes: Math.max(0, bytes - item.chunk_count * FILE_LIMITS.AEAD_TAG),
        };
    }
    // A row without the refs on the wire: the payload has them (one worker call, rare).
    const { getFilePayload } = await import("$lib/modules/files/download");
    const payload = await getFilePayload(item.id);
    if (!payload) return null;
    return {
        chunkSetId: payload.chunkSetId,
        count: payload.chunks.length,
        bytes: payload.size,
        plainBytes: payload.size,
    };
}

/**
 * Whether the export has to ask before downloading: only when a file goes beyond what this device's
 * auto-download policy would fetch on its own. Under `always`
 * never, under `never` whenever something is missing; the policy grows with size, so the largest
 * file decides for `small-only`.
 */
export function needsDownloadNotice(missing: MissingFiles | null): boolean {
    return !!missing && missing.count > 0 && !shouldAutoDownload(missing.largest);
}

export async function measureMissingFiles(): Promise<MissingFilesReport> {
    const live = await loadLiveItems();
    const liveNotes = new Set(live.filter((i) => i.type === "note").map((i) => i.id));
    const report: MissingFilesReport = {
        all: { count: 0, bytes: 0, largest: 0 },
        embedded: { count: 0, bytes: 0, largest: 0 },
    };
    for (const item of live) {
        if (item.type !== "file" || FileLifecycle.stateOf(item) !== "READY") continue;
        const refs = await chunkRefs(item);
        // Unreadable metadata: the export will skip it and say so. A set without chunks has nothing
        // to download, though `hasAllChunks` calls it incomplete.
        if (!refs || refs.count === 0 || (await hasAllChunks(refs.chunkSetId, refs.count))) {
            continue;
        }
        const scopes =
            item.parent_id && liveNotes.has(item.parent_id)
                ? [report.all, report.embedded]
                : [report.all];
        for (const scope of scopes) {
            scope.count++;
            scope.bytes += refs.bytes;
            scope.largest = Math.max(scope.largest, refs.plainBytes);
        }
    }
    return report;
}
