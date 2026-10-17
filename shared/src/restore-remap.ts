// The new id of a restored item whose original id the server has purged. It lives in
// the shared package because both sides compute it: the client stages the item under this id, and
// the server recomputes it to accept that id as a proven remap rather than refuse it as outside the
// manifest.
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * A deterministic UUID from (backup_hash, the old id) — on a resume, the same file restages to the
 * same new ids even with no saved map (e.g. after an eviction).
 *
 * The output is part of the restore contract: an open session and a repeated restore of the same
 * file both rely on getting the same ids again, so the algorithm must not change
 * (`restore-remap.test.ts` pins it).
 */
export function restoreRemapId(backupHash: string, oldId: string): string {
    // backup_hash is already SHA-256 hex; XOR-ing it with the UUID bytes gives a unique, deterministic
    // identity without another hashing dependency.
    const hashHex = backupHash
        .replace(/[^0-9a-f]/gi, "")
        .toLowerCase()
        .padEnd(32, "0");
    const idHex = oldId.replace(/-/g, "").toLowerCase().padEnd(32, "0");
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        const h = Number.parseInt(hashHex.slice(i * 2, i * 2 + 2), 16) || 0;
        const u = Number.parseInt(idHex.slice(i * 2, i * 2 + 2), 16) || 0;
        bytes[i] = h ^ u;
    }
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generation `generation` of the remap. Generation 0 is `restoreRemapId` itself; a later
 * one is needed only when the earlier id is purged as well — a backup restored, the restored copy
 * purged, and the same file restored again. Remapping the remapped id would not do: the XOR undoes
 * itself and lands back on the original, so each generation XORs with its own hash, derived from
 * (backup_hash, generation).
 */
export function restoreRemapIdAt(backupHash: string, oldId: string, generation: number): string {
    if (generation === 0) return restoreRemapId(backupHash, oldId);
    const digest = sha256(new TextEncoder().encode(`${backupHash}:${generation}`));
    const derived = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    return restoreRemapId(derived, oldId);
}
