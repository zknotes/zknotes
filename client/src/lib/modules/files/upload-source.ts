// An abstraction over the plaintext's source for an upload — a File, OPFS staging or an IDB blob.
import type { PendingUpload } from "$lib/core/db";
import { isStagingComplete, readStagingSlice } from "./opfs-staging";

export type UploadSource =
    | {
          kind: "file";
          name: string;
          mime: string;
          size: number;
          file: File;
      }
    | {
          kind: "opfs";
          name: string;
          mime: string;
          size: number;
          stagingId: string;
      };

export function uploadSourceFromFile(file: File): UploadSource {
    return {
        kind: "file",
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        file,
    };
}

export function uploadSourceFromPending(
    pending: PendingUpload,
    file?: File | Blob,
): UploadSource | null {
    if (isStagingComplete(pending) && pending.staging_id) {
        return {
            kind: "opfs",
            name: pending.name,
            mime: pending.mime,
            size: pending.plain_size ?? 0,
            stagingId: pending.staging_id,
        };
    }
    const blob = file ?? pending.blob;
    if (!blob) return null;
    const f =
        blob instanceof File
            ? blob
            : new File([blob], pending.name, { type: pending.mime || "application/octet-stream" });
    return uploadSourceFromFile(f);
}

export async function readPlaintextSlice(
    source: UploadSource,
    offset: number,
    length: number,
): Promise<Uint8Array> {
    if (source.kind === "file") {
        const slice = source.file.slice(offset, offset + length);
        return new Uint8Array(await slice.arrayBuffer());
    }
    return readStagingSlice(source.stagingId, offset, length);
}
