import { afterEach, describe, expect, it, vi } from "vitest";
import { openFilePickerSink, triggerAnchorDownload } from "./download-sink";

// Saas spec 157: the one "Save as" / anchor download behind the export, the file download and the
// share attachment download.
afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
});

describe("triggerAnchorDownload", () => {
    it("clicks a temporary anchor carrying the url and the file name, then removes it", () => {
        const clicked: string[] = [];
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
            this: HTMLAnchorElement,
        ) {
            clicked.push(`${this.getAttribute("href")}|${this.download}`);
        });
        triggerAnchorDownload("blob:x", "report.pdf");
        expect(clicked).toEqual(["blob:x|report.pdf"]);
        expect(document.querySelector("a")).toBeNull();
    });
});

describe("openFilePickerSink", () => {
    it("is null without a picker, and null when the picker refuses quietly", async () => {
        expect(await openFilePickerSink("a.zip", { onAbort: () => new Error("x") })).toBeNull();
        vi.stubGlobal("showSaveFilePicker", async () => {
            throw new DOMException("no gesture", "SecurityError");
        });
        expect(await openFilePickerSink("a.zip", { onAbort: () => new Error("x") })).toBeNull();
    });

    it("turns the user's cancel into the caller's own error", async () => {
        vi.stubGlobal("showSaveFilePicker", async () => {
            throw new DOMException("cancelled", "AbortError");
        });
        class Cancelled extends Error {}
        await expect(
            openFilePickerSink("a.zip", { onAbort: () => new Cancelled() }),
        ).rejects.toBeInstanceOf(Cancelled);
    });

    it("passes the accepted types only when given, and streams into the chosen file", async () => {
        const written: Uint8Array[] = [];
        let closed = false;
        const opts: unknown[] = [];
        vi.stubGlobal("showSaveFilePicker", async (o: unknown) => {
            opts.push(o);
            return {
                createWritable: async () => ({
                    write: async (b: Uint8Array) => {
                        written.push(b);
                    },
                    close: async () => {
                        closed = true;
                    },
                }),
            };
        });
        const sink = await openFilePickerSink("a.zip", {
            accept: { "application/zip": [".zip"] },
            onAbort: () => new Error("x"),
        });
        await sink?.write(new Uint8Array([1]));
        await sink?.close();
        await sink?.abort();
        expect(written).toHaveLength(1);
        expect(closed).toBe(true);
        expect(opts[0]).toEqual({
            suggestedName: "a.zip",
            types: [{ accept: { "application/zip": [".zip"] } }],
        });

        await openFilePickerSink("b.bin", { onAbort: () => new Error("x") });
        expect(opts[1]).toEqual({ suggestedName: "b.bin" });
    });
});
