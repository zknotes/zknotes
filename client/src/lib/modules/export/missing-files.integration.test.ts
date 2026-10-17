import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const policy = vi.hoisted(() => ({ autoDownload: vi.fn((_size: number | null) => true) }));

vi.mock("$lib/modules/files/sync-settings", () => ({
    shouldAutoDownload: (size: number | null) => policy.autoDownload(size),
}));

vi.mock("$lib/modules/files/download", () => ({
    // Only the row without chunk refs reaches the payload.
    getFilePayload: vi.fn(async (id: string) =>
        id === "file-no-refs"
            ? { kind: "file", chunkSetId: "cs-no-refs", chunks: [{}, {}], size: 30 }
            : null,
    ),
}));

import { getDB, type LocalItem } from "$lib/core/db";
import { type MissingFiles, measureMissingFiles, needsDownloadNotice } from "./missing-files";

function row(id: string, type: LocalItem["type"], extra: Partial<LocalItem> = {}): LocalItem {
    return {
        id,
        type,
        parent_id: null,
        encrypted_payload: "cA==",
        payload_nonce: "A".repeat(32),
        encrypted_item_key: "C".repeat(64),
        item_key_nonce: "B".repeat(32),
        sort_order: "m",
        version: 1,
        ...extra,
    } as LocalItem;
}

function file(id: string, parent: string | null, sets: Partial<LocalItem>): LocalItem {
    return row(id, "file", { parent_id: parent, ...sets });
}

async function cacheChunk(chunkSetId: string, index: number): Promise<void> {
    const db = await getDB();
    await db.put("file-chunks", {
        key: `${chunkSetId}:${index}`,
        chunkSetId,
        index,
        ciphertext: new Uint8Array([1, 2, 3]),
        nonce: new Uint8Array(24),
        storedAt: Date.now(),
    });
}

describe("measureMissingFiles", () => {
    beforeEach(async () => {
        const db = await getDB();
        await db.clear("items");
        await db.clear("file-chunks");
    });

    it("counts the live files without every chunk here, and sums their ciphertext", async () => {
        const db = await getDB();
        for (const item of [
            row("note", "note"),
            row("folder", "folder"),
            // One of two chunks cached — still a download.
            file("in-note-partial", "note", {
                chunk_set_id: "cs-a",
                chunk_count: 2,
                ciphertext_size: 100,
            }),
            file("in-folder-remote", "folder", {
                chunk_set_id: "cs-b",
                chunk_count: 1,
                ciphertext_size: 50,
            }),
            file("in-note-local", "note", {
                chunk_set_id: "cs-c",
                chunk_count: 1,
                ciphertext_size: 70,
            }),
            file("in-trash", "note", {
                chunk_set_id: "cs-d",
                chunk_count: 1,
                ciphertext_size: 900,
                deleted_at: 1,
            }),
            file("file-no-refs", null, {}),
            file("no-chunks", "note", { chunk_set_id: "cs-g", chunk_count: 0, ciphertext_size: 0 }),
        ]) {
            await db.put("items", item);
        }
        await cacheChunk("cs-a", 0);
        await cacheChunk("cs-c", 0);

        const report = await measureMissingFiles();

        // in-note-partial + in-folder-remote + file-no-refs (size from its payload). The largest
        // plaintext is in-note-partial: 100 bytes of ciphertext minus one 16-byte tag per chunk.
        expect(report.all).toEqual({ count: 3, bytes: 100 + 50 + 30, largest: 100 - 2 * 16 });
        // Only the file whose owner is a live note — what an export without attachments still needs.
        expect(report.embedded).toEqual({ count: 1, bytes: 100, largest: 100 - 2 * 16 });
    });

    it("reports nothing when every chunk is here", async () => {
        const db = await getDB();
        await db.put("items", row("note", "note"));
        await db.put(
            "items",
            file("local", "note", { chunk_set_id: "cs-x", chunk_count: 1, ciphertext_size: 10 }),
        );
        await cacheChunk("cs-x", 0);

        expect(await measureMissingFiles()).toEqual({
            all: { count: 0, bytes: 0, largest: 0 },
            embedded: { count: 0, bytes: 0, largest: 0 },
        });
    });
});

// The rule for the notice: ask only when a missing file goes beyond what the
// device's auto-download policy would fetch on its own.
describe("needsDownloadNotice", () => {
    const missing = (largest: number): MissingFiles => ({ count: 2, bytes: largest + 10, largest });

    it("never asks when nothing is missing or nothing was measured", () => {
        policy.autoDownload.mockImplementation(() => false);
        expect(needsDownloadNotice(null)).toBe(false);
        expect(needsDownloadNotice({ count: 0, bytes: 0, largest: 0 })).toBe(false);
    });

    it("follows the policy: always → no, never → yes, small-only → by the largest file", () => {
        policy.autoDownload.mockImplementation(() => true);
        expect(needsDownloadNotice(missing(20 * 1024 * 1024))).toBe(false);

        policy.autoDownload.mockImplementation(() => false);
        expect(needsDownloadNotice(missing(10))).toBe(true);

        policy.autoDownload.mockImplementation((size) => size !== null && size <= 5 * 1024 * 1024);
        expect(needsDownloadNotice(missing(1024 * 1024))).toBe(false);
        expect(needsDownloadNotice(missing(20 * 1024 * 1024))).toBe(true);
    });
});
