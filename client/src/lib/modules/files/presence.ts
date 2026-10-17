// The presence check for the file cache (selective sync).
// It reads chunk_set_id + chunk_count from the IDB items (plaintext metadata — nothing is decrypted)
// and checks whether the whole chunk set is cached locally. The result is the source of truth for the
// presence badge in the UI.
import { getDB } from "$lib/core/db";
import { hasAllChunks } from "$lib/core/db/file-chunks";

/** "cloud" = the ciphertext has not been fetched locally; "downloaded" = every chunk is local → available offline. */
export type FilePresence = "cloud" | "downloaded";

/**
 * Returns "downloaded" when every chunk of this file is cached locally, otherwise "cloud".
 * It reads plaintext metadata only (chunk_set_id, chunk_count) — nothing is decrypted.
 */
export async function checkFilePresence(fileId: string): Promise<FilePresence> {
    const db = await getDB();
    const item = await db.get("items", fileId);
    const chunkSetId = item?.chunk_set_id;
    const chunkCount = item?.chunk_count;
    if (!chunkSetId || !chunkCount) return "cloud";
    const hasAll = await hasAllChunks(chunkSetId, chunkCount);
    return hasAll ? "downloaded" : "cloud";
}
