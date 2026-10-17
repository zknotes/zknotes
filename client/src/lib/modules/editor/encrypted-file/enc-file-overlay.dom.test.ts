/**
 * What a failed upload shows when the server refuses the file as too large: the limit
 * from the response, and Abort — for an image (the overlay) and for any other file (the chip).
 */
import { describe, expect, it, vi } from "vitest";

// The overlay reads its percentage from the upload module; the failure path does not need it.
vi.mock("$lib/modules/files/upload", () => ({ computeUploadDisplayPct: () => 0 }));

import { ApiError } from "$lib/core/api/client";
import { uploadErrorMessage } from "$lib/modules/files/upload-errors";
import type { UploadState } from "$lib/modules/files/upload-manager";
import { makePendingFileChip } from "./enc-file-chip";
import { makeUploadOverlay } from "./enc-file-overlay";

function refusedAsTooLarge(): UploadState {
    const refusal = new ApiError("file_too_large", 413, {
        error: "file_too_large",
        max_file_size: 26_214_400,
    });
    return {
        status: "failed",
        phase: "encrypting",
        chunkIndex: 0,
        totalChunks: 0,
        error: uploadErrorMessage(refusal),
    };
}

function button(el: HTMLElement, label: string): HTMLButtonElement | undefined {
    return [...el.querySelectorAll("button")].find((b) => b.textContent === label);
}

describe("a 413 file_too_large on the node", () => {
    it("the image overlay says the server's limit and offers Abort", () => {
        const onAbort = vi.fn();
        const overlay = makeUploadOverlay(refusedAsTooLarge(), { onRetry: vi.fn(), onAbort });

        expect(overlay.textContent).toContain("Too large — the limit is 25 MB");
        button(overlay, "Abort")?.click();
        expect(onAbort).toHaveBeenCalledOnce();
    });

    it("the file chip says the same and offers Abort", () => {
        const onAbort = vi.fn();
        const chip = makePendingFileChip("archive.zip", { onRetry: vi.fn(), onAbort });

        chip.update(refusedAsTooLarge());

        expect(chip.el.textContent).toContain("Too large — the limit is 25 MB");
        button(chip.el, "Abort")?.click();
        expect(onAbort).toHaveBeenCalledOnce();
    });
});
