// The RPC client for the OPFS dedicated worker.

type WorkerReply = { id: number; type: "OK" | "ERROR"; payload?: unknown; error?: string };

let worker: Worker | null = null;
let messageId = 0;
const pending = new Map<
    number,
    { resolve: (v: WorkerReply) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL("./opfs-io.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<WorkerReply>) => {
            const msg = event.data;
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            p.resolve(msg);
        };
        worker.onerror = (e) => {
            console.error("OPFS worker error:", e);
        };
    }
    return worker;
}

function send<T = unknown>(
    type: string,
    payload: Record<string, unknown>,
    transfer?: Transferable[],
): Promise<T> {
    const id = ++messageId;
    const w = getWorker();
    return new Promise((resolve, reject) => {
        pending.set(id, {
            resolve: (msg) => {
                if (msg.type === "ERROR") reject(new Error(msg.error ?? "OPFS worker error"));
                else resolve((msg.payload ?? {}) as T);
            },
            reject,
        });
        w.postMessage({ id, type, ...payload }, transfer ?? []);
    });
}

let syncSupported: boolean | null = null;

export async function opfsSupportsSync(): Promise<boolean> {
    if (syncSupported !== null) return syncSupported;
    if (typeof Worker === "undefined" || typeof navigator?.storage?.getDirectory !== "function") {
        syncSupported = false;
        return false;
    }
    try {
        const res = await send<{ supported: boolean }>("SUPPORTS_SYNC", {});
        syncSupported = res.supported === true;
    } catch {
        syncSupported = false;
    }
    return syncSupported;
}

export async function truncateSource(stagingId: string, size: number): Promise<void> {
    await send("TRUNCATE_SOURCE", { stagingId, size });
}

export async function writeSourceBlock(
    stagingId: string,
    offset: number,
    data: Uint8Array,
): Promise<void> {
    const copy = data.slice();
    await send("WRITE_SOURCE_BLOCK", { stagingId, offset, data: copy.buffer }, [copy.buffer]);
}

export async function readSourceSlice(
    stagingId: string,
    offset: number,
    length: number,
): Promise<Uint8Array> {
    const res = await send<{ buffer: ArrayBuffer }>("READ_SOURCE_SLICE", {
        stagingId,
        offset,
        length,
    });
    return new Uint8Array(res.buffer);
}

export async function deleteStagingDir(stagingId: string): Promise<void> {
    try {
        await send("DELETE_STAGING", { stagingId });
    } catch {
        // best-effort
    }
}
