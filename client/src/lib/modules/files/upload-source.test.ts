import { describe, expect, it } from "vitest";
import { uploadSourceFromFile, uploadSourceFromPending } from "./upload-source";

describe("uploadSourceFromPending", () => {
    it("prefers OPFS when staging is complete", () => {
        const src = uploadSourceFromPending({
            local_id: "loc-1",
            name: "a.png",
            mime: "image/png",
            plain_size: 10,
            staging_id: "loc-1",
            staging_bytes_written: 10,
            note_id: null,
            parent_id: null,
            created_at: 1,
        });
        expect(src?.kind).toBe("opfs");
        if (src?.kind === "opfs") expect(src.stagingId).toBe("loc-1");
    });

    it("falls back to blob when OPFS incomplete", () => {
        const blob = new Blob([new Uint8Array([1])]);
        const src = uploadSourceFromPending({
            local_id: "loc-2",
            name: "b.png",
            mime: "image/png",
            blob,
            note_id: null,
            parent_id: null,
            created_at: 1,
        });
        expect(src?.kind).toBe("file");
    });

    it("uploadSourceFromFile wraps File", () => {
        const file = new File([new Uint8Array([1])], "c.png", { type: "image/png" });
        const src = uploadSourceFromFile(file);
        expect(src.kind).toBe("file");
        expect(src.size).toBe(1);
    });
});
