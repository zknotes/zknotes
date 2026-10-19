// Handing bytes to the user: the File System Access "Save as" (streams to disk in Chrome/Edge) and
// the anchor-click download everything else gets. The backup/export sink, the file download and the
// share attachment download each used to carry their own copy of these, and two of the picker copies
// had already drifted (one passed `types`, the other did not).

export interface FsWritableLike {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(reason?: unknown): Promise<void>;
}
export interface FsFileHandleLike {
    createWritable(): Promise<FsWritableLike>;
    getFile?(): Promise<File>;
}
interface FsSavePicker {
    showSaveFilePicker?: (opts: {
        suggestedName?: string;
        types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<FsFileHandleLike>;
}

/** What a streaming download writes into — a picked file, or an in-memory blob. */
export interface ByteSink {
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(reason?: unknown): Promise<void>;
}

/** Clicks a temporary anchor so the browser saves `url` under `filename`. The caller owns the URL. */
export function triggerAnchorDownload(url: string, filename: string): void {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

/**
 * Opens the "Save as" picker and returns a sink onto the chosen file, or `null` when the browser
 * has no picker or refused it quietly (a SecurityError: no user gesture, say) — the caller then
 * falls back to a blob download. A user who cancels the picker gets the caller's own error.
 */
export async function openFilePickerSink(
    filename: string,
    opts: { accept?: Record<string, string[]>; onAbort: () => Error },
): Promise<ByteSink | null> {
    if (typeof window === "undefined") return null;
    const picker = window as unknown as FsSavePicker;
    if (typeof picker.showSaveFilePicker !== "function") return null;
    let handle: FsFileHandleLike;
    try {
        handle = await picker.showSaveFilePicker({
            suggestedName: filename,
            ...(opts.accept ? { types: [{ accept: opts.accept }] } : {}),
        });
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw opts.onAbort();
        return null;
    }
    const writable = await handle.createWritable();
    return {
        write: (bytes) => writable.write(bytes),
        close: () => writable.close(),
        abort: (reason) => writable.abort?.(reason) ?? Promise.resolve(),
    };
}
