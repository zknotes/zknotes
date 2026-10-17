import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getFilePayload } = vi.hoisted(() => ({ getFilePayload: vi.fn() }));

// For handleStreamRequest; ensureStreamServiceWorker uses none of these.
vi.mock("$lib/core/events/file-bridge", () => ({ fileBridge: { getFilePayload } }));
vi.mock("$lib/modules/files/download", () => ({
    peekSniffFile: vi.fn(async () => ({ render: "video", mime: "video/mp4" })),
}));
// Only a pull of the stream reaches these; the tests never pull.
vi.mock("$lib/core/files/chunk-loader", () => ({ loadChunk: vi.fn() }));
vi.mock("$lib/core/workers/crypto-rpc", () => ({ decryptChunkTask: vi.fn() }));

import {
    ensureStreamServiceWorker,
    handleStreamRequest,
    parseRangeHeader,
    type RequestStreamMessage,
    type StreamResponseMessage,
} from "./sw-bridge";

// Starting a video or audio must not activate a waiting SW. When the page already has a
// controller, the stream runs on that one — forcing SKIP_WAITING would fire controllerchange → a
// reload in the middle of playback. With no controller, forcing it is the only way
// /zknotes/stream/ gets intercepted at all, so there it has to stay.

type Listener = (ev?: unknown) => void;

function makeWaitingWorker() {
    return { postMessage: vi.fn(), addEventListener: vi.fn() };
}

function installEnv(opts: {
    controller: unknown;
    waiting?: { postMessage: ReturnType<typeof vi.fn> };
}) {
    const listeners = new Map<string, Listener[]>();
    const registration = {
        waiting: opts.waiting ?? null,
        installing: null,
    };
    const serviceWorker = {
        controller: opts.controller,
        ready: Promise.resolve(registration),
        register: vi.fn().mockResolvedValue(registration),
        addEventListener: (type: string, fn: Listener) => {
            listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        },
        removeEventListener: () => {},
    };
    vi.stubGlobal("navigator", { serviceWorker });
    return {
        emitControllerChange() {
            for (const fn of listeners.get("controllerchange") ?? []) fn();
        },
        serviceWorker,
    };
}

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("ensureStreamServiceWorker", () => {
    it("does not activate a waiting worker when the page is already controlled", async () => {
        const waiting = makeWaitingWorker();
        installEnv({ controller: {}, waiting });

        await expect(ensureStreamServiceWorker()).resolves.toBe(true);

        expect(waiting.postMessage).not.toHaveBeenCalled();
    });

    it("forces SKIP_WAITING when the page has no controller yet", async () => {
        const waiting = makeWaitingWorker();
        const env = installEnv({ controller: null, waiting });

        const pending = ensureStreamServiceWorker(50);
        await vi.waitFor(() =>
            expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" }),
        );

        env.serviceWorker.controller = {};
        env.emitControllerChange();

        await expect(pending).resolves.toBe(true);
    });

    it("returns false without service worker support", async () => {
        vi.stubGlobal("navigator", {});
        await expect(ensureStreamServiceWorker()).resolves.toBe(false);
    });
});

// ── The Range protocol: no E2E plays video or audio, so these are the only tests. ──

describe("parseRangeHeader", () => {
    it.each<[string | undefined, number, ReturnType<typeof parseRangeHeader>]>([
        ["bytes=0-99", 1000, { start: 0, end: 99 }],
        ["bytes=900-", 1000, { start: 900, end: 999 }],
        ["bytes=-100", 1000, { start: 900, end: 999 }],
        ["bytes=0-5000", 1000, { start: 0, end: 999 }],
        ["bytes=1000-", 1000, "unsatisfiable"],
        ["bytes=-0", 1000, "unsatisfiable"],
        ["bytes=500-400", 1000, "unsatisfiable"],
        ["bytes=0-1,5-9", 1000, null],
        ["items=0-1", 1000, null],
        [undefined, 1000, null],
        ["bytes=0-", 0, "unsatisfiable"],
    ])("%s of %i bytes → %j", (header, size, expected) => {
        expect(parseRangeHeader(header, size)).toEqual(expected);
    });
});

describe("handleStreamRequest", () => {
    beforeEach(() => {
        getFilePayload.mockResolvedValue({
            kind: "file",
            chunkSetId: "cs-1",
            chunks: [{ nonce: "AAAA" }, { nonce: "AAAA" }],
            size: 1000,
            chunkSize: 512,
            mime: "video/mp4",
        });
    });

    function request(reqId: string, range: string): RequestStreamMessage {
        return { type: "REQUEST_STREAM", fileId: "file-1", reqId, headers: { range } };
    }

    function fakePort() {
        const postMessage =
            vi.fn<(msg: StreamResponseMessage, transfer?: Transferable[]) => void>();
        return { port: { postMessage } as unknown as MessagePort, postMessage };
    }

    it("a satisfiable range → STREAM_READY with that range and the file's total size (the SW's 206)", async () => {
        const { port, postMessage } = fakePort();

        await handleStreamRequest(request("req-ok", "bytes=100-199"), port);

        expect(postMessage).toHaveBeenCalledOnce();
        const [reply, transfer] = postMessage.mock.calls[0] ?? [];
        expect(reply).toMatchObject({
            type: "STREAM_READY",
            mime: "video/mp4",
            size: 1000,
            range: { start: 100, end: 199 },
        });
        expect(transfer).toEqual([(reply as { stream: unknown }).stream]);
    });

    it("an unsatisfiable range → STREAM_ERROR with status 416 and the total size", async () => {
        const { port, postMessage } = fakePort();

        await handleStreamRequest(request("req-416", "bytes=1000-"), port);

        expect(postMessage).toHaveBeenCalledWith({
            type: "STREAM_ERROR",
            error: "Range Not Satisfiable",
            status: 416,
            totalSize: 1000,
        });
    });
});
