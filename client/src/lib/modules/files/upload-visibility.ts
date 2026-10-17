// Tab visibility throttle for uploads.
import { sleep } from "./upload-errors";

export const MAX_CONCURRENT_CHUNKS_VISIBLE = 3;
export const MAX_CONCURRENT_CHUNKS_HIDDEN = 1;

let tabHidden = false;
let listenerInstalled = false;

function onVisibilityChange(): void {
    tabHidden = document.visibilityState === "hidden";
}

/** Installs the global listener (idempotent). */
export function initUploadVisibilityListener(): void {
    if (listenerInstalled || typeof document === "undefined") return;
    listenerInstalled = true;
    tabHidden = document.visibilityState === "hidden";
    document.addEventListener("visibilitychange", onVisibilityChange);
}

export function isUploadTabHidden(): boolean {
    return tabHidden;
}

export function getMaxConcurrentChunks(): number {
    return tabHidden ? MAX_CONCURRENT_CHUNKS_HIDDEN : MAX_CONCURRENT_CHUNKS_VISIBLE;
}

/** A short pause between chunks while the tab is hidden — it reduces the background throttling. */
export async function throttleBetweenChunks(): Promise<void> {
    if (tabHidden) await sleep(50);
}
