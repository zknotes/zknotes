// The upload progress / retry-abort overlay for pending (`local:`) IMAGES in the encFile NodeView —
// lifted out of enc-file-node.ts. Pending non-image files use makePendingFileChip
// (enc-file-chip.ts) instead of an overlay.

import { computeUploadDisplayPct } from "$lib/modules/files/upload";
import type { UploadState } from "$lib/modules/files/upload-manager";

export interface OverlayHandlers {
    onRetry: () => void;
    onAbort: () => void;
}

/** Builds the overlay element for the current upload state; the NodeView (re)mounts it. */
export function makeUploadOverlay(
    state: UploadState | undefined,
    handlers: OverlayHandlers,
): HTMLElement {
    const overlay = document.createElement("span");
    overlay.contentEditable = "false";
    overlay.addEventListener("mousedown", (e) => e.stopPropagation());

    const bar = document.createElement("span");
    bar.className = "block h-1 rounded-full bg-black/50 overflow-hidden";
    const fill = document.createElement("span");
    fill.className = "block h-full bg-brand0 transition-all";
    bar.appendChild(fill);

    let isUploading = false;
    let statusText = "Upload paused";

    if (state && state.status === "uploading") {
        isUploading = true;
        const total = state.totalChunks ?? 0;
        const chunkIndex = state.chunkIndex ?? 0;
        const pct = computeUploadDisplayPct(state) ?? 0;

        statusText =
            state.phase === "finalizing" || state.phase === "committing"
                ? "Finishing…"
                : total > 1
                  ? `Uploading ${pct}% (${Math.min(chunkIndex + 1, total)}/${total})`
                  : `Uploading ${pct}%`;

        overlay.className =
            "absolute bottom-1 left-1 right-1 flex flex-col gap-1 pointer-events-none";

        fill.style.width = `${pct}%`;
        fill.className = "block h-full bg-brand0 transition-all";
    } else {
        statusText = !state ? "Upload paused" : state.error || "Upload failed";
        overlay.className =
            "absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-md bg-black/70 text-center px-3";
        bar.style.display = "none";
    }

    const text = document.createElement("span");
    text.className =
        "self-start text-2xs font-mono px-1.5 py-0.5 rounded bg-black/65 text-amber-300";
    text.textContent = statusText;
    overlay.appendChild(text);
    overlay.appendChild(bar);

    const actions = document.createElement("div");
    actions.className = "flex gap-2 mt-1 pointer-events-auto justify-center";

    if (!isUploading) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className =
            "text-xs px-2 py-1 rounded bg-brand0 hover:bg-brand0 text-white font-medium";
        retry.textContent = !state ? "Resume" : "Retry";
        retry.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            handlers.onRetry();
        });
        actions.appendChild(retry);
    }

    const abort = document.createElement("button");
    abort.type = "button";
    abort.className =
        "text-xs px-2 py-1 rounded bg-[var(--surface-raised)] hover:bg-[var(--row-hover)] text-[var(--text)] pointer-events-auto";
    abort.textContent = !state ? "Cancel" : "Abort";
    abort.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        handlers.onAbort();
    });

    actions.appendChild(abort);
    overlay.appendChild(actions);

    return overlay;
}
