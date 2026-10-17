// Runs the real crypto worker (crypto.worker.ts) inside the test process, so an integration test
// exercises the production Item Key unwrap, AAD checks and key cache instead of a stand-in.

import { vi } from "vitest";
import type { CryptoWorkerFactory } from "./crypto-rpc";

type Listener = ((event: MessageEvent) => void) | null;

/**
 * Evaluates crypto.worker.ts against a stubbed dedicated-worker `self` and returns a factory for
 * `new CryptoWorkerClient(factory)` whose port talks to it. Messages are structured-cloned and
 * delivered asynchronously, like postMessage. The stub stays installed for the rest of the test
 * file: the worker looks `self` up again for every reply it posts.
 */
export async function loadInProcessCryptoWorker(): Promise<CryptoWorkerFactory> {
    const workerScope = {
        onmessage: null as Listener,
        postMessage(message: unknown) {
            const data = structuredClone(message);
            queueMicrotask(() => clientPort.onmessage?.({ data } as MessageEvent));
        },
    };
    const clientPort = {
        onmessage: null as Listener,
        start() {},
        postMessage(message: unknown) {
            const data = structuredClone(message);
            queueMicrotask(() => workerScope.onmessage?.({ data } as MessageEvent));
        },
    };

    vi.stubGlobal("self", workerScope);
    await import("./crypto.worker");
    if (!workerScope.onmessage) {
        throw new Error("crypto.worker.ts was evaluated before the in-process stub was installed");
    }
    return () => clientPort as unknown as MessagePort;
}
