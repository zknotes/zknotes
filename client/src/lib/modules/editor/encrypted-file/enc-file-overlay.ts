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

/** A stable hook on the "not downloaded on this device" card — the tests and E2E look it up by this. */
export const NOT_LOCAL_ATTR = "data-encfile-not-local";

export interface NotLocalCardOptions {
    /**
     * `"idle"` → "Not downloaded on this device" with a Load button; `"loading"` → the same box
     * with a spinner text and the button disabled; `"error"` → the fetch the user asked for failed,
     * with a Retry button.
     */
    state: "idle" | "loading" | "error";
    /** True when the node is a declared image (the copy says "image" instead of "file"). */
    isImage: boolean;
    /** The user's resize width or the intrinsic width — the card takes the same box as the image would. */
    width: string | null;
    /** The intrinsic ratio (`"1600 / 900"`), so the card reserves the same height as the image. */
    aspectRatio: string | null;
    /** The user asked for the download — the NodeView runs the forced resolve. */
    onLoad: () => void;
}

/**
 * The placeholder for a file the device's auto-download policy did not fetch (`FileNotLocalError`).
 * It is NOT an error: the file is fine, it is only in the cloud on this device, so the card offers
 * a tap to load it — the same explicit action as the Info panel's "Load preview". It takes the box
 * the image would occupy (the width and aspect ratio the node carries), so loading it causes no
 * layout jump; a node with no dimensions gets a fixed small box instead.
 */
export function makeNotLocalCard(opts: NotLocalCardOptions): HTMLElement {
    const card = document.createElement("div");
    card.contentEditable = "false";
    card.setAttribute(NOT_LOCAL_ATTR, opts.state);
    card.className = [
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed",
        "border-[color-mix(in_srgb,var(--stroke)_70%,transparent)]",
        "bg-[color-mix(in_srgb,var(--surface-panel)_60%,transparent)]",
        "text-[var(--text-dim)] text-center px-3 py-4 max-w-full select-none",
        opts.state === "loading" ? "cursor-progress" : "cursor-pointer",
    ].join(" ");
    if (opts.width) card.style.width = opts.width;
    if (opts.aspectRatio) card.style.aspectRatio = opts.aspectRatio;
    else card.style.minHeight = "6rem";
    if (!opts.width && !opts.aspectRatio) card.style.width = "16rem";

    const noun = opts.isImage ? "Image" : "File";
    const text = document.createElement("span");
    text.className = "text-xs leading-snug";
    text.textContent =
        opts.state === "loading"
            ? `Loading ${noun.toLowerCase()}…`
            : opts.state === "error"
              ? `Couldn't load the ${noun.toLowerCase()} — check the connection and try again`
              : `${noun} not downloaded on this device`;
    card.appendChild(text);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
        "text-xs px-2.5 py-1 rounded bg-brand0 hover:bg-brand0 text-white font-medium disabled:opacity-60";
    btn.textContent =
        opts.state === "loading" ? "Loading…" : opts.state === "error" ? "Retry" : "Tap to load";
    btn.disabled = opts.state === "loading";
    card.appendChild(btn);

    // The whole card is the tap target (a thumb on a phone), the button is only the affordance.
    // mousedown must not reach ProseMirror — it would turn the tap into a node selection.
    card.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
    });
    card.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (opts.state !== "loading") opts.onLoad();
    });

    return card;
}
