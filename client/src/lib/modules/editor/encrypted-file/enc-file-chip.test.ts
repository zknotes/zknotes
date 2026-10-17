// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
    CHIP_NAME_ATTR,
    CHIP_RESTORE_ATTR,
    makeFileChip,
    makePendingFileChip,
} from "./enc-file-chip";

/**
 * A regression: NodeView.update() looked for the file's name through the Tailwind
 * class `.text-[13px]`, which no longer exists in the chip, so the name was never refreshed after a
 * rename. The name now carries a stable `data-chip-name` hook — these tests hold that contract.
 */
describe("chip name hook", () => {
    it("makeFileChip marks the name with CHIP_NAME_ATTR", () => {
        const chip = makeFileChip("report.pdf", { mime: "application/pdf" });
        const nameEl = chip.querySelector(`[${CHIP_NAME_ATTR}]`);
        expect(nameEl?.textContent).toBe("report.pdf");
    });

    it("makePendingFileChip marks the name with CHIP_NAME_ATTR", () => {
        const chip = makePendingFileChip("upload.zip", { onRetry: vi.fn(), onAbort: vi.fn() });
        const nameEl = chip.el.querySelector(`[${CHIP_NAME_ATTR}]`);
        expect(nameEl?.textContent).toBe("upload.zip");
    });

    it("the selector matches exactly one element, leaving no ambiguity in update()", () => {
        const chip = makeFileChip("photo.png", { mime: "image/png", deletedMsg: "File deleted" });
        expect(chip.querySelectorAll(`[${CHIP_NAME_ATTR}]`).length).toBe(1);
    });

    it("the name can be rewritten through the hook (the path NodeView.update() takes)", () => {
        const chip = makeFileChip("old.pdf", { mime: "application/pdf" });
        const nameEl = chip.querySelector(`[${CHIP_NAME_ATTR}]`);
        if (nameEl) nameEl.textContent = "new.pdf";
        expect(chip.textContent).toContain("new.pdf");
        expect(chip.textContent).not.toContain("old.pdf");
    });
});

/**
 * A regression: the TRASHED placeholder should offer "File in trash / Restore", but the button
 * was not there — `encfile:restore` had a listener in NoteFileEvents that nothing ever fired.
 */
describe("The TRASHED placeholder — the Restore button", () => {
    it("onRestore renders a button with a stable hook and calls the callback on a click", () => {
        const onRestore = vi.fn();
        const chip = makeFileChip("photo.png", {
            mime: "image/png",
            deletedMsg: "Image in trash",
            onRestore,
        });

        const btn = chip.querySelector<HTMLElement>(`[${CHIP_RESTORE_ATTR}]`);
        expect(btn).not.toBeNull();
        expect(btn?.title).toBe("Restore from trash");

        btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(onRestore).toHaveBeenCalledTimes(1);
    });

    it("with no onRestore there is no button (the DELETED placeholder carries Remove, not Restore)", () => {
        const chip = makeFileChip("photo.png", {
            mime: "image/png",
            deletedMsg: "Image deleted",
            onRemove: vi.fn(),
        });
        expect(chip.querySelector(`[${CHIP_RESTORE_ATTR}]`)).toBeNull();
    });
});
