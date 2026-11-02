// Regression: the search index on a FRESH crypto worker (a reload, a new browser session — the
// SharedWorker dies with the last tab). A delta pull that lands before loadOrBuildIndex used to add
// its documents to an empty worker, which created a new index holding only them; the flush then
// persisted that partial index over the complete one, and the next load took it as complete —
// searching by content stopped finding every other note until the blob happened to be rebuilt.
//
// Uses the REAL crypto.worker.ts in-process (crypto-worker.testkit.ts) and the real
// core/search/index.ts — only the module singleton `cryptoWorker` is redirected to the in-process
// worker; fake-indexeddb stands in for IndexedDB.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/core/workers/crypto-rpc", async (importOriginal) => {
    const mod = (await importOriginal()) as typeof import("$lib/core/workers/crypto-rpc");
    const { loadInProcessCryptoWorker } = await import("$lib/core/workers/crypto-worker.testkit");
    const factory = await loadInProcessCryptoWorker();
    const client = new mod.CryptoWorkerClient(factory);
    return {
        ...mod,
        cryptoWorker: client,
        unlockWorker: (vk: Uint8Array) => client.unlock(vk),
        logoutWorker: () => client.logout(),
        buildIndexTask: (docs: never) => client.buildIndex(docs),
        addIndexDocTask: (doc: never) => client.addIndexDoc(doc),
        addIndexDocsTask: (docs: never) => client.addIndexDocs(docs),
        removeIndexDocTask: (id: string) => client.removeIndexDoc(id),
        searchIndexTask: (q: string, l?: number) => client.searchIndex(q, l),
        serializeIndexTask: () => client.serializeIndex(),
        loadPersistedIndexTask: (b: never) => client.loadPersistedIndex(b),
    };
});

import { getDB } from "$lib/core/db";
import { logoutWorker, type SearchDoc, unlockWorker } from "$lib/core/workers/crypto-rpc";
import {
    addOrUpdateDocs,
    cancelPendingPersist,
    flushIndex,
    isSearchIndexLoaded,
    loadOrBuildIndex,
    resumeIndexPersistenceAndFlush,
    search,
    suspendIndexPersistence,
} from "./index";

const VK = new Uint8Array(32).fill(7);
const COMPLETE: SearchDoc[] = [
    { id: "n1", type: "note", title: "Alpha", content: "the alpha note" },
    { id: "n2", type: "note", title: "Bravo", content: "the bravo note" },
    { id: "n3", type: "note", title: "Charlie", content: "the charlie note" },
];
const PULLED: SearchDoc = { id: "n4", type: "note", title: "Delta", content: "the delta note" };

const ids = async (query: string) => (await search(query)).map((h) => h.id).sort();

/** Session 1: an unlock, the index built (empty vault, nothing persisted yet) and three notes indexed and persisted. */
async function seedCompletePersistedIndex(): Promise<void> {
    await unlockWorker(VK.slice());
    const built = await loadOrBuildIndex();
    expect(built).toEqual({ rebuilt: true, count: 0 });
    await addOrUpdateDocs(COMPLETE);
    await flushIndex();
    expect(await ids("bravo")).toEqual(["n2"]);
}

/**
 * The tab is reloaded: the session teardown flushes and forgets the index on this side, and the
 * SharedWorker dies with the last tab — INIT on a fresh worker holds no index (wipeSessionSecrets).
 */
async function reloadIntoFreshWorker(): Promise<void> {
    await flushIndex();
    cancelPendingPersist();
    await logoutWorker();
    await unlockWorker(VK.slice());
    expect(isSearchIndexLoaded()).toBe(false);
}

/** What pull.ts does for one page of changed items. */
async function deltaPull(docs: SearchDoc[]): Promise<void> {
    suspendIndexPersistence();
    try {
        await addOrUpdateDocs(docs);
    } finally {
        await resumeIndexPersistenceAndFlush();
    }
}

describe("search index: a delta pull on a fresh worker", () => {
    beforeEach(async () => {
        cancelPendingPersist();
        await logoutWorker();
        const db = await getDB();
        await db.clear("items");
        await db.clear("search-index");
    });

    it("a pull that lands BEFORE the index is loaded does not overwrite the complete persisted index", async () => {
        await seedCompletePersistedIndex();
        await reloadIntoFreshWorker();

        // The pull arrives first (the old layout order): one note changed on another device.
        await deltaPull([PULLED]);

        // Then the index is loaded: still the complete one, three notes, every content searchable.
        const loaded = await loadOrBuildIndex();
        expect(loaded).toEqual({ rebuilt: false, count: 3 });
        expect(await ids("bravo")).toEqual(["n2"]);
        expect(await ids("charlie")).toEqual(["n3"]);
    });

    it("in the layout's order — load first, then pull — the pulled items extend the complete index and persist", async () => {
        await seedCompletePersistedIndex();
        await reloadIntoFreshWorker();

        const loaded = await loadOrBuildIndex();
        expect(loaded).toEqual({ rebuilt: false, count: 3 });
        await deltaPull([PULLED]);

        expect(await ids("delta")).toEqual(["n4"]);
        expect(await ids("bravo")).toEqual(["n2"]);

        // The next reload loads all four from the persisted blob.
        await reloadIntoFreshWorker();
        const again = await loadOrBuildIndex();
        expect(again).toEqual({ rebuilt: false, count: 4 });
        expect(await ids("delta")).toEqual(["n4"]);
        expect(await ids("alpha")).toEqual(["n1"]);
    });
});
