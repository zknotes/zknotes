/**
 * The crypto worker's message handling: INIT, PING and LOGOUT, and what LOGOUT and a second
 * INIT must wipe. Nothing else runs `handleMessage`; the E2E flows only pass through it.
 *
 * How: a fake global `self` is set before the worker module is imported. There is no
 * SharedWorkerGlobalScope in node, so the worker takes its dedicated path and registers
 * `self.onmessage`; the test sends messages through it and reads the replies from `postMessage`. The
 * worker keeps its state at module level, so every test starts from a LOGOUT.
 */
import {
    buildChunkAad,
    buildPayloadAad,
    buildShareWrapAad,
    deriveShareKey,
    encryptChunk,
    encryptItemKey,
    encryptPayload,
    generateItemKey,
    generateShareLinkKey,
    shareLinkKeyToB64url,
} from "@zknotes/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type Reply = { id: number; type: string; payload?: Record<string, unknown>; error?: string };

const replies: Reply[] = [];
const fakeSelf: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: (reply: Reply) => void;
} = {
    onmessage: null,
    postMessage: (reply) => {
        replies.push(reply);
    },
};

let nextId = 0;

/** Sends one message and waits for its reply (`handleMessage` is async). */
async function send(type: string, payload?: unknown): Promise<Reply> {
    const id = ++nextId;
    if (!fakeSelf.onmessage) throw new Error("the worker did not register self.onmessage");
    fakeSelf.onmessage({ data: { id, type, payload } } as MessageEvent);
    for (let i = 0; i < 100; i++) {
        const reply = replies.find((r) => r.id === id);
        if (reply) return reply;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`no reply to ${type}`);
}

/** A Vault Key buffer the test keeps: INIT views it without copying, so its wipe is visible here. */
function vaultKeyBuffer(fill: number): ArrayBuffer {
    return new Uint8Array(32).fill(fill).buffer;
}

const isZeroed = (buffer: ArrayBuffer) => new Uint8Array(buffer).every((b) => b === 0);

beforeAll(async () => {
    (globalThis as { self?: unknown }).self = fakeSelf;
    await import("./crypto.worker");
});

afterAll(() => {
    delete (globalThis as { self?: unknown }).self;
});

beforeEach(async () => {
    await send("LOGOUT");
});

describe("crypto worker — INIT, PING and LOGOUT", () => {
    it("PING says locked before INIT and unlocked after it", async () => {
        expect((await send("PING")).payload).toEqual({ isUnlocked: false });

        expect((await send("INIT", { vaultKey: vaultKeyBuffer(7) })).type).toBe("INIT_SUCCESS");

        expect((await send("PING")).payload).toEqual({ isUnlocked: true });
    });

    it("ADD_ITEM_KEY before INIT is refused", async () => {
        const reply = await send("ADD_ITEM_KEY", {
            itemId: "item-1",
            encryptedItemKey: [1, 2, 3],
            itemKeyNonce: [4, 5, 6],
        });

        expect(reply).toMatchObject({ type: "ERROR", error: "Worker not unlocked" });
    });

    it("LOGOUT zeroes the Vault Key it was given, and PING says locked again", async () => {
        const key = vaultKeyBuffer(9);
        await send("INIT", { vaultKey: key });
        expect(isZeroed(key)).toBe(false);

        expect((await send("LOGOUT")).type).toBe("LOGOUT_SUCCESS");

        expect(isZeroed(key)).toBe(true);
        expect((await send("PING")).payload).toEqual({ isUnlocked: false });
    });

    it("a second INIT zeroes the previous key and forgets the previous Item Keys", async () => {
        const first = vaultKeyBuffer(1);
        await send("INIT", { vaultKey: first });
        expect((await send("GENERATE_ITEM_KEY", { itemId: "item-a" })).type).toBe(
            "GENERATE_ITEM_KEY_SUCCESS",
        );
        const encrypted = await send("ENCRYPT_PAYLOAD", {
            itemId: "item-a",
            data: { title: "before" },
            version: 1,
        });
        expect(encrypted.type).toBe("ENCRYPT_PAYLOAD_SUCCESS");

        await send("INIT", { vaultKey: vaultKeyBuffer(2) });

        expect(isZeroed(first)).toBe(true);
        const reply = await send("DECRYPT_PAYLOAD", {
            itemId: "item-a",
            ciphertext: encrypted.payload?.ciphertext,
            nonce: encrypted.payload?.nonce,
            version: 1,
        });
        expect(reply).toMatchObject({ type: "ERROR", error: "Item key not found for item-a" });
    });

    it("SEARCH_INDEX after LOGOUT finds nothing from the previous session", async () => {
        await send("INIT", { vaultKey: vaultKeyBuffer(3) });
        await send("BUILD_INDEX", {
            docs: [{ id: "n1", type: "note", title: "Quarterly salaries", content: "private" }],
        });
        const before = await send("SEARCH_INDEX", { query: "salaries" });
        expect(before.payload?.results).toHaveLength(1);

        await send("LOGOUT");

        const after = await send("SEARCH_INDEX", { query: "salaries" });
        expect(after).toMatchObject({ type: "SEARCH_INDEX_SUCCESS", payload: { results: [] } });
    });
});

// A decrypt that finished before LOGOUT, whose index write lands after it, must not bring
// plaintext back into a locked worker — every index mutation needs the Vault Key.
describe("crypto worker — index mutations on a locked worker", () => {
    const doc = { id: "n1", type: "note", title: "Quarterly salaries", content: "private" };

    it.each(["BUILD_INDEX", "ADD_INDEX_DOC", "ADD_INDEX_DOCS", "REMOVE_INDEX_DOC"])(
        "%s before INIT is refused",
        async (type) => {
            const payload =
                type === "ADD_INDEX_DOC"
                    ? { doc }
                    : type === "REMOVE_INDEX_DOC"
                      ? { docId: "n1" }
                      : { docs: [doc] };
            const reply = await send(type, payload);
            expect(reply).toMatchObject({ type: "ERROR", error: "Worker not unlocked" });
        },
    );

    it("a late ADD_INDEX_DOCS after LOGOUT leaves the worker without an index", async () => {
        await send("INIT", { vaultKey: vaultKeyBuffer(4) });
        await send("LOGOUT");

        const reply = await send("ADD_INDEX_DOCS", { docs: [doc] });

        expect(reply).toMatchObject({ type: "ERROR", error: "Worker not unlocked" });
        await send("INIT", { vaultKey: vaultKeyBuffer(4) });
        const after = await send("SEARCH_INDEX", { query: "salaries" });
        expect(after.payload?.results).toEqual([]);
    });
});

// On a fresh worker the delta pull used to arrive before the persisted index was loaded; an add
// then created a NEW index holding only the pulled items, and the flush persisted that partial
// index over the complete one.
describe("crypto worker — adding to an index that is not loaded yet", () => {
    const doc = { id: "n4", type: "note", title: "Delta", content: "the delta note" };

    it("ADD_INDEX_DOC(S) without an index report indexed: false and create none", async () => {
        await send("INIT", { vaultKey: vaultKeyBuffer(5) });

        const one = await send("ADD_INDEX_DOC", { doc });
        const many = await send("ADD_INDEX_DOCS", { docs: [doc] });

        expect(one).toMatchObject({ type: "ADD_INDEX_DOC_SUCCESS", payload: { indexed: false } });
        expect(many).toMatchObject({
            type: "ADD_INDEX_DOCS_SUCCESS",
            payload: { indexed: false },
        });
        expect((await send("SEARCH_INDEX", { query: "delta" })).payload?.results).toEqual([]);
        // Nothing to serialise either — a flush must not write a partial blob.
        expect((await send("SERIALIZE_INDEX")).payload).toEqual({ empty: true });
    });

    it("once an index is loaded the same adds extend it", async () => {
        await send("INIT", { vaultKey: vaultKeyBuffer(5) });
        await send("BUILD_INDEX", {
            docs: [{ id: "n1", type: "note", title: "Alpha", content: "the alpha note" }],
        });

        const reply = await send("ADD_INDEX_DOCS", { docs: [doc] });

        expect(reply).toMatchObject({ type: "ADD_INDEX_DOCS_SUCCESS", payload: { indexed: true } });
        const hits = (await send("SEARCH_INDEX", { query: "delta" })).payload?.results as Array<{
            id: string;
        }>;
        expect(hits.map((h) => h.id)).toEqual(["n4"]);
        expect((await send("SEARCH_INDEX", { query: "alpha" })).payload?.results).toHaveLength(1);
    });
});

// A share download needs the attachment's Item Key for every chunk. It stays in the worker's key
// cache, and the chunks go through DECRYPT_CHUNK — the raw key never reaches the main thread.
describe("crypto worker — a retained share Item Key never leaves the worker", () => {
    const shareId = "01900000-0000-7000-8000-00000000000a";
    const fileId = "01900000-0000-7000-8000-00000000000b";
    const chunkSetId = "01900000-0000-7000-8000-00000000000c";

    function makeShare() {
        const linkKey = generateShareLinkKey();
        const fragmentKeyB64url = shareLinkKeyToB64url(linkKey);
        const shareKey = deriveShareKey(linkKey);
        const itemKey = generateItemKey();
        const wrapped = encryptItemKey(itemKey, shareKey, buildShareWrapAad(shareId, fileId));
        const payload = {
            kind: "file",
            title: "doc.bin",
            name: "doc.bin",
            mime: "application/octet-stream",
            size: 3,
            chunkSetId,
            chunks: [],
        };
        const enc = encryptPayload(payload, itemKey, buildPayloadAad(fileId, 1));
        const chunkPlain = new Uint8Array([7, 8, 9]);
        const chunk = encryptChunk(chunkPlain, itemKey, buildChunkAad(chunkSetId, 0, 1));
        return {
            unwrapPayload: {
                shareId,
                sourceItemId: fileId,
                wrappedItemKey: Array.from(wrapped.ciphertext),
                itemKeyNonce: Array.from(wrapped.nonce),
                encryptedPayload: Array.from(enc.ciphertext),
                payloadNonce: Array.from(enc.nonce),
                fragmentKeyB64url,
                version: 1,
            },
            chunk,
            chunkPlain,
        };
    }

    it("retainItemKey caches the key under the item id and answers with a flag, not the key", async () => {
        const { unwrapPayload, chunk, chunkPlain } = makeShare();

        // The share page runs without a vault session — no INIT here on purpose.
        const reply = await send("UNWRAP_AND_DECRYPT_SHARE", {
            ...unwrapPayload,
            retainItemKey: true,
        });

        expect(reply.type).toBe("UNWRAP_AND_DECRYPT_SHARE_SUCCESS");
        expect(reply.payload).toMatchObject({ itemKeyRetained: true, data: { kind: "file" } });
        expect(reply.payload).not.toHaveProperty("itemKey");

        const decrypted = await send("DECRYPT_CHUNK", {
            itemId: fileId,
            chunkSetId,
            chunkIndex: 0,
            totalChunks: 1,
            ciphertext: chunk.ciphertext,
            nonce: chunk.nonce,
        });
        expect(decrypted.type).toBe("DECRYPT_CHUNK_SUCCESS");
        expect(new Uint8Array(decrypted.payload?.plaintext as ArrayBuffer)).toEqual(chunkPlain);
    });

    it("without retainItemKey the key is not cached, and the raw-key chunk path is gone", async () => {
        const { unwrapPayload, chunk } = makeShare();

        const reply = await send("UNWRAP_AND_DECRYPT_SHARE", unwrapPayload);
        expect(reply.payload).toMatchObject({ itemKeyRetained: false });

        const decrypted = await send("DECRYPT_CHUNK", {
            itemId: fileId,
            chunkSetId,
            chunkIndex: 0,
            totalChunks: 1,
            ciphertext: chunk.ciphertext,
            nonce: chunk.nonce,
        });
        expect(decrypted).toMatchObject({
            type: "ERROR",
            error: `Item key not found for ${fileId}`,
        });

        const legacy = await send("DECRYPT_CHUNK_WITH_KEY", {});
        expect(legacy).toMatchObject({ type: "ERROR", error: expect.stringContaining("Unknown") });
    });

    it("LOGOUT forgets a retained share key", async () => {
        const { unwrapPayload, chunk } = makeShare();
        await send("UNWRAP_AND_DECRYPT_SHARE", { ...unwrapPayload, retainItemKey: true });

        await send("LOGOUT");

        const decrypted = await send("DECRYPT_CHUNK", {
            itemId: fileId,
            chunkSetId,
            chunkIndex: 0,
            totalChunks: 1,
            ciphertext: chunk.ciphertext,
            nonce: chunk.nonce,
        });
        expect(decrypted).toMatchObject({
            type: "ERROR",
            error: `Item key not found for ${fileId}`,
        });
    });
});
