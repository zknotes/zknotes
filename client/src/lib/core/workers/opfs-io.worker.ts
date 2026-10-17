// A dedicated worker for OPFS sync read/write. FileSystemSyncAccessHandle only —
// the encryption and the PUT stay on the main thread / in the crypto worker.

import { OpfsKeyedMutex } from "./opfs-keyed-mutex";

const UPLOADS_DIR = "uploads";
const stagingMutex = new OpfsKeyedMutex();
const SOURCE_FILE = "source";

type WorkerRequest =
    | { id: number; type: "SUPPORTS_SYNC" }
    | { id: number; type: "TRUNCATE_SOURCE"; stagingId: string; size: number }
    | {
          id: number;
          type: "WRITE_SOURCE_BLOCK";
          stagingId: string;
          offset: number;
          data: ArrayBuffer;
      }
    | { id: number; type: "READ_SOURCE_SLICE"; stagingId: string; offset: number; length: number }
    | { id: number; type: "DELETE_STAGING"; stagingId: string };

type WorkerResponse =
    | { id: number; type: "OK"; payload?: unknown }
    | { id: number; type: "ERROR"; error: string };

async function getStagingDir(
    stagingId: string,
    create: boolean,
): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    const uploads = await root.getDirectoryHandle(UPLOADS_DIR, { create: true });
    return uploads.getDirectoryHandle(stagingId, { create });
}

async function withSourceSyncHandle<T>(
    stagingId: string,
    create: boolean,
    fn: (handle: FileSystemSyncAccessHandle) => T | Promise<T>,
): Promise<T> {
    const dir = await getStagingDir(stagingId, create);
    const fileHandle = await dir.getFileHandle(SOURCE_FILE, { create });
    const syncHandle = await fileHandle.createSyncAccessHandle();
    try {
        return await fn(syncHandle);
    } finally {
        syncHandle.close();
    }
}

async function handleRequest(req: WorkerRequest): Promise<WorkerResponse> {
    try {
        switch (req.type) {
            case "SUPPORTS_SYNC": {
                const root = await navigator.storage.getDirectory();
                const probe = await root.getFileHandle(".opfs-probe", { create: true });
                const h = await probe.createSyncAccessHandle();
                h.close();
                await root.removeEntry(".opfs-probe");
                return { id: req.id, type: "OK", payload: { supported: true } };
            }
            case "TRUNCATE_SOURCE": {
                await withSourceSyncHandle(req.stagingId, true, (h) => {
                    h.truncate(req.size);
                });
                return { id: req.id, type: "OK" };
            }
            case "WRITE_SOURCE_BLOCK": {
                const bytes = new Uint8Array(req.data);
                await withSourceSyncHandle(req.stagingId, true, (h) => {
                    h.write(bytes, { at: req.offset });
                });
                return { id: req.id, type: "OK" };
            }
            case "READ_SOURCE_SLICE": {
                const buf = new Uint8Array(req.length);
                await withSourceSyncHandle(req.stagingId, false, (h) => {
                    h.read(buf, { at: req.offset });
                });
                return { id: req.id, type: "OK", payload: { buffer: buf.buffer } };
            }
            case "DELETE_STAGING": {
                const root = await navigator.storage.getDirectory();
                const uploads = await root.getDirectoryHandle(UPLOADS_DIR, { create: false });
                await uploads.removeEntry(req.stagingId, { recursive: true });
                return { id: req.id, type: "OK" };
            }
            default:
                return { id: (req as WorkerRequest).id, type: "ERROR", error: "unknown_request" };
        }
    } catch (e) {
        return {
            id: req.id,
            type: "ERROR",
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

function stagingIdFromRequest(req: WorkerRequest): string | null {
    if ("stagingId" in req && typeof req.stagingId === "string") return req.stagingId;
    return null;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const req = event.data;
    const stagingId = stagingIdFromRequest(req);
    const run = stagingId
        ? () => stagingMutex.run(stagingId, () => handleRequest(req))
        : () => handleRequest(req);

    void run().then((res) => {
        if (res.type === "OK" && res.payload && (res.payload as { buffer?: ArrayBuffer }).buffer) {
            const buffer = (res.payload as { buffer: ArrayBuffer }).buffer;
            self.postMessage(res, [buffer]);
        } else {
            self.postMessage(res);
        }
    });
};
