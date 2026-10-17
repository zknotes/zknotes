/**
 * The crypto worker's message handling: INIT, PING and LOGOUT, and what LOGOUT and a second
 * INIT must wipe. Nothing else runs `handleMessage`; the E2E flows only pass through it.
 *
 * How: a fake global `self` is set before the worker module is imported. There is no
 * SharedWorkerGlobalScope in node, so the worker takes its dedicated path and registers
 * `self.onmessage`; the test sends messages through it and reads the replies from `postMessage`. The
 * worker keeps its state at module level, so every test starts from a LOGOUT.
 */
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
