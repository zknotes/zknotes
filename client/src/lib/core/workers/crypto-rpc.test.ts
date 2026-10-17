// Tests for the CryptoWorkerClient class with an injected fake port — without
// vi.mock-ing the whole module: factory injection exists for exactly this.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoWorkerClient, PING_RETRY_TIMEOUT_MS } from "./crypto-rpc";

/** A fake MessagePort: it records the messages sent and lets the test answer by hand. */
function createFakePort() {
    const sent: Array<{ id: number; type: string; payload?: unknown }> = [];
    const port = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        started: false,
        start() {
            this.started = true;
        },
        postMessage(msg: { id: number; type: string; payload?: unknown }) {
            sent.push(msg);
        },
    };
    const respond = (reply: Record<string, unknown>) => {
        port.onmessage?.({ data: reply } as MessageEvent);
    };
    return { port: port as unknown as MessagePort, raw: port, sent, respond };
}

describe("CryptoWorkerClient", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not spawn the worker until the first RPC call (lazy init)", () => {
        const factory = vi.fn(() => createFakePort().port);
        const client = new CryptoWorkerClient(factory);
        expect(factory).not.toHaveBeenCalled();

        void client.ping();
        expect(factory).toHaveBeenCalledOnce();
        void client.ping();
        expect(factory).toHaveBeenCalledOnce(); // the port is created once and cached
    });

    it("starts the port and attaches the message handler", () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);
        void client.logout();
        expect(fake.raw.started).toBe(true);
        expect(fake.raw.onmessage).toBeTypeOf("function");
    });

    it("correlates responses to requests by id", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const p1 = client.encryptPayload("item-1", { t: "a" }, 1);
        const p2 = client.encryptPayload("item-2", { t: "b" }, 2);
        expect(fake.sent).toHaveLength(2);
        const [m1, m2] = fake.sent;

        // Answer in the reverse order — every promise has to get ITS OWN payload.
        fake.respond({
            id: m2?.id,
            type: "ENCRYPT_PAYLOAD_SUCCESS",
            payload: { ciphertext: [2], nonce: [22] },
        });
        fake.respond({
            id: m1?.id,
            type: "ENCRYPT_PAYLOAD_SUCCESS",
            payload: { ciphertext: [1], nonce: [11] },
        });

        expect((await p1).ciphertext).toEqual(new Uint8Array([1]));
        expect((await p2).ciphertext).toEqual(new Uint8Array([2]));
    });

    it("rejects on ERROR reply", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const p = client.decryptPayload("item-x", new Uint8Array([1]), new Uint8Array([2]), 1);
        const msg = fake.sent[0];
        expect(msg?.type).toBe("DECRYPT_PAYLOAD");
        fake.respond({ id: msg?.id, type: "ERROR", error: "Item key not found for item-x" });

        await expect(p).rejects.toThrow("Item key not found for item-x");
    });

    it("rejects with timeout when the worker never answers (default 2s)", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const p = client.logout();
        const assertion = expect(p).rejects.toThrow("Worker request timed out: LOGOUT");
        await vi.advanceTimersByTimeAsync(2001);
        await assertion;
    });

    // A regression: the worker is single-threaded — BUILD_INDEX (up to 60s)
    // and LOAD_PERSISTED_INDEX (30s) can block the event loop during a cold start on a large vault.
    // The per-item calls queued behind them (ADD_ITEM_KEY, DECRYPT_PAYLOAD, ENCRYPT_PAYLOAD) shared a
    // GLOBAL 2s default → they timed out silently while waiting behind a long index operation, and
    // getTreeItems/rebuildIndex swallowed that as "Encrypted..." with no message to the user at all.
    it("addCachedItemKey and decryptPayload survive a worker busy for several seconds", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const p = client.decryptPayload("item-x", new Uint8Array([1]), new Uint8Array([2]), 1);
        // It must not time out at 2s (the old default) — the worker is "busy" with a longer operation.
        await vi.advanceTimersByTimeAsync(3000);
        const msg = fake.sent[0];
        fake.respond({
            id: msg?.id,
            type: "DECRYPT_PAYLOAD_SUCCESS",
            payload: { data: { ok: true } },
        });
        await expect(p).resolves.toEqual({ ok: true });
    });

    // Every RPC that can queue behind BUILD_INDEX (a synchronous addAll that holds the
    // SharedWorker for seconds) waits as long as a per-item one.
    const doc = { id: "n1", type: "note" as const, title: "t" };
    it.each<[string, (c: CryptoWorkerClient) => Promise<unknown>, Record<string, unknown>]>([
        [
            "encryptPayloadWithNewKey",
            (c) => c.encryptPayloadWithNewKey("item-x", { a: 1 }, 1),
            { encryptedItemKey: [1], itemKeyNonce: [2], ciphertext: [3], nonce: [4] },
        ],
        [
            "generateItemKey",
            (c) => c.generateItemKey("item-x"),
            { encryptedItemKey: [1], itemKeyNonce: [2] },
        ],
        ["addIndexDoc", (c) => c.addIndexDoc(doc), {}],
        ["addIndexDocs", (c) => c.addIndexDocs([doc]), {}],
        ["removeIndexDoc", (c) => c.removeIndexDoc("n1"), {}],
        ["searchIndex", (c) => c.searchIndex("q"), { results: [] }],
    ])("%s survives a worker busy for 5 s", async (_name, call, payload) => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const p = call(client);
        await vi.advanceTimersByTimeAsync(5000);
        fake.respond({ id: fake.sent[0]?.id, type: "OK", payload });

        await expect(p).resolves.not.toThrow();
    });

    it("pingStatus tells a worker that did not answer from one that is locked", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const silent = client.pingStatus();
        await vi.advanceTimersByTimeAsync(2000);
        await expect(silent).resolves.toBe("timeout");

        const locked = client.pingStatus();
        fake.respond({ id: fake.sent[1]?.id, type: "PONG", payload: { isUnlocked: false } });
        await expect(locked).resolves.toBe(false);

        const broken = client.pingStatus();
        fake.respond({ id: fake.sent[2]?.id, type: "ERROR", error: "boom" });
        await expect(broken).resolves.toBe(false);
    });

    it("a PING answered after 5 s times out once, and the patient second one gets the answer", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const first = client.pingStatus();
        await vi.advanceTimersByTimeAsync(2000);
        await expect(first).resolves.toBe("timeout");
        const second = client.pingStatus(PING_RETRY_TIMEOUT_MS);
        await vi.advanceTimersByTimeAsync(3000);
        // The worker gets to both PINGs in order; the reply to the first finds nobody waiting.
        fake.respond({ id: fake.sent[0]?.id, type: "PONG", payload: { isUnlocked: true } });
        fake.respond({ id: fake.sent[1]?.id, type: "PONG", payload: { isUnlocked: true } });

        await expect(second).resolves.toBe(true);
    });

    it("ping() keeps its shape for the old callers: a timeout reads as false", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const p = client.ping();
        await vi.advanceTimersByTimeAsync(2000);

        await expect(p).resolves.toBe(false);
    });

    // A regression: decryptPayload was ADD_ITEM_KEY + DECRYPT_PAYLOAD =
    // 2 postMessage round trips PER ITEM. getTreeItems over 5000 items × 20 invalidations = 10,000+
    // round trips per save. decryptMany sends the WHOLE batch in one postMessage.
    it("decryptMany batches N items into a single worker round-trip", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const items = Array.from({ length: 10 }, (_, i) => ({
            itemId: `item-${i}`,
            encryptedItemKey: new Uint8Array([i]),
            itemKeyNonce: new Uint8Array([i]),
            ciphertext: new Uint8Array([i]),
            nonce: new Uint8Array([i]),
            version: 1,
        }));

        const p = client.decryptMany(items);
        // One postMessage for all 10 items — not 20 (the old 2×N pattern).
        expect(fake.sent).toHaveLength(1);
        const msg = fake.sent[0];
        expect(msg?.type).toBe("DECRYPT_MANY");

        fake.respond({
            id: msg?.id,
            type: "DECRYPT_MANY_SUCCESS",
            payload: {
                results: items.map((it) => ({ itemId: it.itemId, data: { title: it.itemId } })),
            },
        });

        const results = await p;
        expect(results).toHaveLength(10);
        expect(results[0]).toEqual({ itemId: "item-0", data: { title: "item-0" } });
    });

    // A regression: decryptItemPayload used to be ADD_ITEM_KEY + DECRYPT_PAYLOAD =
    // 2 postMessage round trips. decryptPayloadWithKey sends both in ONE message.
    it("decryptPayloadWithKey sends one combined postMessage", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const p = client.decryptPayloadWithKey(
            "item-x",
            new Uint8Array([1]),
            new Uint8Array([2]),
            new Uint8Array([3]),
            new Uint8Array([4]),
            1,
        );
        expect(fake.sent).toHaveLength(1);
        const msg = fake.sent[0];
        expect(msg?.type).toBe("DECRYPT_PAYLOAD_WITH_KEY");

        fake.respond({
            id: msg?.id,
            type: "DECRYPT_PAYLOAD_WITH_KEY_SUCCESS",
            payload: { data: { ok: true } },
        });
        await expect(p).resolves.toEqual({ ok: true });
    });

    it("ping() swallows errors and reports locked state", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const p = client.ping();
        const msg = fake.sent[0];
        fake.respond({ id: msg?.id, type: "ERROR", error: "boom" });
        expect(await p).toBe(false);
    });

    it("ignores replies for unknown or already-settled ids", async () => {
        const fake = createFakePort();
        const client = new CryptoWorkerClient(() => fake.port);

        const p = client.ping();
        const msg = fake.sent[0];
        fake.respond({ id: 9999, type: "PONG", payload: { isUnlocked: true } }); // an unknown id
        fake.respond({ id: msg?.id, type: "PONG", payload: { isUnlocked: true } });
        fake.respond({ id: msg?.id, type: "PONG", payload: { isUnlocked: false } }); // a duplicate

        expect(await p).toBe(true);
    });

    it("unlock transfers a copy so the caller's buffer stays intact", async () => {
        const transfers: Transferable[][] = [];
        const sent: Array<{ id: number; type: string; payload?: { vaultKey?: ArrayBuffer } }> = [];
        const port = {
            onmessage: null as ((event: MessageEvent) => void) | null,
            start() {},
            postMessage(
                msg: { id: number; type: string; payload?: { vaultKey?: ArrayBuffer } },
                transfer?: Transferable[],
            ) {
                sent.push(msg);
                transfers.push(transfer ?? []);
            },
        };
        const client = new CryptoWorkerClient(() => port as unknown as MessagePort);

        const key = new Uint8Array([7, 7, 7, 7]);
        const p = client.unlock(key);
        const msg = sent[0];
        expect(msg?.type).toBe("INIT");
        expect(transfers[0]).toHaveLength(1);
        // The original buffer is NOT transferred (a copy is) — the caller zeroizes it itself.
        expect(key.byteLength).toBe(4);

        port.onmessage?.({ data: { id: msg?.id, type: "INIT_SUCCESS" } } as MessageEvent);
        await expect(p).resolves.toBeUndefined();
    });
});
