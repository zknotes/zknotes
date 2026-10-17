/**
 * The Markdown export over the fixture vault. It lives in the dom project because the content
 * rewrite parses note HTML with DOMParser and sanitises it with DOMPurify.
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
import { exportMarkdown } from "./markdown-export";
import { createMemorySink } from "./sink";

async function exportToFiles(includeFiles = true): Promise<Record<string, string>> {
    const mem = createMemorySink();
    const result = await exportMarkdown({ includeFiles, sink: mem.sink });
    expect(result.skipped).toEqual([]);
    const files = unzipSync(mem.bytes());
    return Object.fromEntries(
        Object.entries(files).map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]),
    );
}

describe("Markdown export", () => {
    beforeEach(async () => {
        cryptoState.resetKeys();
        s3Store.clear();
        await clearVaultStores();
        await seedFixtureVault(cryptoState);
    });

    // The module this replaced never decrypted folder titles, so every directory was "Untitled".
    it("mirrors the folder tree with the folders' real names", async () => {
        const files = await exportToFiles();
        const paths = Object.keys(files);
        expect(paths).toContain("Projects/Hello.md");
        expect(paths).toContain("Projects/Nested/Deep note.md");
        expect(paths).toContain("Unicode 🔐.md");
        expect(paths.some((p) => p.startsWith("Untitled/"))).toBe(false);
        expect(files["Projects/Hello.md"]?.startsWith("# Hello\n")).toBe(true);
    });

    it("includes the attachments, embedded or not", async () => {
        const files = await exportToFiles(true);
        const paths = Object.keys(files);
        expect(paths.some((p) => p.startsWith(`_attachments/${FIXTURE_IDS.fileUnderNote}/`))).toBe(
            true,
        );
        expect(paths.some((p) => p.startsWith(`_attachments/${FIXTURE_IDS.fileMulti}/`))).toBe(
            true,
        );
    });

    it("leaves standalone attachments out when asked to", async () => {
        const paths = Object.keys(await exportToFiles(false));
        expect(paths.some((p) => p.startsWith(`_attachments/${FIXTURE_IDS.fileMulti}/`))).toBe(
            false,
        );
    });
});
