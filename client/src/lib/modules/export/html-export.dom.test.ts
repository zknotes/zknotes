/**
 * The HTML export under the "never" auto-download policy. It lives in the dom
 * project because the page rewrite parses note HTML with DOMParser and sanitises it with DOMPurify.
 *
 * Crypto: in-process @zknotes/shared (not the SharedWorker). The server: a mock S3 map (getChunk).
 */
import "fake-indexeddb/auto";
import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cryptoState = vi.hoisted(() => {
    const vaultKey = new Uint8Array(32).fill(0x42);
    const itemKeys = new Map<string, Uint8Array>();
    return { vaultKey, itemKeys, resetKeys: () => itemKeys.clear() };
});

const s3Store = vi.hoisted(() => new Map<string, Uint8Array>());

vi.mock("$lib/core/workers/crypto-rpc", async () => {
    const { createCryptoRpcMock } = await import("./backup-test-crypto.testkit");
    return createCryptoRpcMock(cryptoState);
});

vi.mock("$lib/core/api", () => ({
    getChunk: vi.fn(async (chunkSetId: string, index: number) => {
        const ct = s3Store.get(`https://s3.test/${chunkSetId}/${index}`);
        if (!ct) throw new Error(`chunk miss ${chunkSetId}:${index}`);
        return ct.slice();
    }),
}));

vi.mock("$lib/modules/files/sync-settings", () => ({
    // The "never" policy, the mobile default: nothing is fetched just for viewing.
    shouldAutoDownload: vi.fn(() => false),
}));

import { getDB } from "$lib/core/db";
import { FIXTURE_IDS } from "./backup-fixture";
import { clearVaultStores, seedFixtureVault } from "./backup-fixture-seed.testkit";
import { exportHtml } from "./html-export";
import { createMemorySink } from "./sink";

/** Moves a file's chunks from this device's cache to the (mock) server. */
async function evictToServer(fileId: string): Promise<void> {
    const db = await getDB();
    const chunkSetId = `cs-${fileId}`;
    const rows = (await db.getAll("file-chunks")).filter((r) => r.chunkSetId === chunkSetId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
        s3Store.set(`https://s3.test/${chunkSetId}/${row.index}`, new Uint8Array(row.ciphertext));
        await db.delete("file-chunks", row.key);
    }
}

describe("HTML export: attachments this device never downloaded", () => {
    beforeEach(async () => {
        cryptoState.resetKeys();
        s3Store.clear();
        await clearVaultStores();
        await seedFixtureVault(cryptoState);
    });

    it("holds a standalone file and an embedded one whose chunks are only on the server", async () => {
        await evictToServer(FIXTURE_IDS.fileMulti);
        await evictToServer(FIXTURE_IDS.fileUnderNote);

        const mem = createMemorySink();
        const result = await exportHtml({ includeFiles: true, sink: mem.sink });

        expect(result.skipped).toEqual([]);
        const paths = Object.keys(unzipSync(mem.bytes()));
        expect(paths.some((p) => p.startsWith(`_attachments/${FIXTURE_IDS.fileMulti}/`))).toBe(
            true,
        );
        expect(paths.some((p) => p.startsWith(`_attachments/${FIXTURE_IDS.fileUnderNote}/`))).toBe(
            true,
        );
    });

    it("leaves no new chunks in the offline cache", async () => {
        await evictToServer(FIXTURE_IDS.fileMulti);
        const db = await getDB();
        const before = await db.count("file-chunks");

        await exportHtml({ includeFiles: true, sink: createMemorySink().sink });

        expect(await db.count("file-chunks")).toBe(before);
    });
});
