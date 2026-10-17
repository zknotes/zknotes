import { describe, expect, it } from "vitest";
import { isRasterImageMime, sniffKind } from "./sniff";

function bytes(...nums: number[]): Uint8Array {
    return new Uint8Array(nums);
}

function withPadding(header: number[], totalLen = 16): Uint8Array {
    const arr = new Uint8Array(totalLen);
    header.forEach((b, i) => {
        arr[i] = b;
    });
    return arr;
}

describe("sniffKind — raster formats", () => {
    it("recognises a PNG by its magic bytes", () => {
        const png = withPadding([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const result = sniffKind(png);
        expect(result.render).toBe("raster");
        expect(result.mime).toBe("image/png");
    });

    it("recognises a JPEG by FF D8 FF", () => {
        const jpeg = withPadding([0xff, 0xd8, 0xff, 0xe0]);
        const result = sniffKind(jpeg);
        expect(result.render).toBe("raster");
        expect(result.mime).toBe("image/jpeg");
    });

    it("recognises GIF87a", () => {
        const gif = withPadding([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
        const result = sniffKind(gif);
        expect(result.render).toBe("raster");
        expect(result.mime).toBe("image/gif");
    });

    it("recognises GIF89a", () => {
        const gif = withPadding([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
        const result = sniffKind(gif);
        expect(result.render).toBe("raster");
        expect(result.mime).toBe("image/gif");
    });

    it("recognises WEBP (RIFF + WEBP at offset 8)", () => {
        const webp = new Uint8Array(16);
        // RIFF
        [0x52, 0x49, 0x46, 0x46].forEach((b, i) => {
            webp[i] = b;
        });
        // the file size bytes (4-7, ignored)
        // WEBP at offset 8
        [0x57, 0x45, 0x42, 0x50].forEach((b, i) => {
            webp[8 + i] = b;
        });
        const result = sniffKind(webp);
        expect(result.render).toBe("raster");
        expect(result.mime).toBe("image/webp");
    });
});

describe("sniffKind — ISOBMFF / video", () => {
    function ftyp(brand: string): Uint8Array {
        const arr = new Uint8Array(16);
        // size (4) placeholder + "ftyp" + brand
        arr[4] = 0x66;
        arr[5] = 0x74;
        arr[6] = 0x79;
        arr[7] = 0x70;
        for (let i = 0; i < 4; i++) arr[8 + i] = brand.charCodeAt(i) || 0x20;
        return arr;
    }

    it("a classic mp42 → video/mp4", () => {
        const r = sniffKind(ftyp("mp42"));
        expect(r).toEqual({ render: "video", mime: "video/mp4" });
    });

    it("modern brands (iso5, hvc1, dash) → video/mp4 (not a download)", () => {
        for (const brand of ["iso5", "iso6", "hvc1", "hev1", "dash", "qt  "]) {
            const r = sniffKind(ftyp(brand));
            expect(r, brand).toEqual({ render: "video", mime: "video/mp4" });
        }
    });

    it("HEIC brand → raster heic (ne video)", () => {
        const r = sniffKind(ftyp("heic"));
        expect(r).toEqual({ render: "raster", mime: "image/heic" });
    });

    it("M4A → audio/mp4", () => {
        const r = sniffKind(ftyp("M4A "));
        expect(r).toEqual({ render: "audio", mime: "audio/mp4" });
    });
});

describe("sniffKind — the download-only formats", () => {
    it("an SVG now comes through as its own 'svg' type, for the DOMPurify sanitisation", () => {
        const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
        const result = sniffKind(svg);
        expect(result.render).toBe("svg");
    });

    it("isRasterImageMime excludes SVG (image/* but not an inline preview)", () => {
        expect(isRasterImageMime("image/png")).toBe(true);
        expect(isRasterImageMime("image/jpeg")).toBe(true);
        expect(isRasterImageMime("image/svg+xml")).toBe(false);
        expect(isRasterImageMime("image/svg+xml; charset=utf-8")).toBe(false);
        expect(isRasterImageMime("image/svg")).toBe(false);
        expect(isRasterImageMime("application/pdf")).toBe(false);
        expect(isRasterImageMime(null)).toBe(false);
        expect(isRasterImageMime(undefined)).toBe(false);
    });

    it("a PDF has to be download-only", () => {
        const pdf = new TextEncoder().encode("%PDF-1.4 ...");
        const result = sniffKind(pdf);
        expect(result.render).toBe("download");
    });

    it("a ZIP has to be download-only", () => {
        const zip = withPadding([0x50, 0x4b, 0x03, 0x04]);
        const result = sniffKind(zip);
        expect(result.render).toBe("download");
    });

    it("random bytes → download", () => {
        const random = withPadding([0x00, 0x01, 0x02, 0x03]);
        const result = sniffKind(random);
        expect(result.render).toBe("download");
    });

    it("an empty Uint8Array → download", () => {
        const result = sniffKind(new Uint8Array(0));
        expect(result.render).toBe("download");
    });

    it("only 2 bytes (too short for any signature) → download", () => {
        const result = sniffKind(bytes(0xff, 0xd8));
        expect(result.render).toBe("download");
    });

    it("RIFF with no WEBP marker at offset 8 → download (no false positive allowed)", () => {
        const notWebp = new Uint8Array(16);
        // RIFF at the start
        [0x52, 0x49, 0x46, 0x46].forEach((b, i) => {
            notWebp[i] = b;
        });
        // AVI instead of WEBP at offset 8
        [0x41, 0x56, 0x49, 0x20].forEach((b, i) => {
            notWebp[8 + i] = b;
        });
        const result = sniffKind(notWebp);
        expect(result.render).toBe("download");
    });
});
