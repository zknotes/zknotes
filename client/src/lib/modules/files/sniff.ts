// Magic-byte sniffing for a safe preview. The `mime` inside the encrypted payload is
// user-controlled metadata and must NOT be trusted when picking the render path — we sniff the real
// decrypted bytes and render only content whose true type we recognise as safe.

/** The render decision, derived from the sniffed bytes and NOT from the declared MIME. */
export type SniffedKind =
    | { render: "raster"; mime: string } // <img src=blob:> — safe
    | { render: "svg"; mime: "image/svg+xml" } // recognised, but the inline preview is a download chip
    | { render: "video"; mime: string } // <video src=/stream/:id>
    | { render: "audio"; mime: string } // <audio src=/stream/:id>
    | { render: "download"; mime: string }; // everything else — download only in v1

/**
 * The declared MIME, for the UI route taken before the bytes are sniffed. An SVG is `image/*`, so it
 * would otherwise take the silent-image path and the NodeView would render it as an `<img>` — vector
 * dimensions (width=4000, say) break the `width:fit-content` wrapper and the image disappears under
 * the sidebar. An SVG is a chip.
 */
export function isRasterImageMime(mime: string | null | undefined): boolean {
    if (!mime) return false;
    const lower = mime.toLowerCase().split(";")[0]!.trim();
    if (lower === "image/svg+xml" || lower === "image/svg") return false;
    return lower.startsWith("image/");
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
    if (bytes.length < offset + sig.length) return false;
    for (let i = 0; i < sig.length; i++) {
        if (bytes[offset + i] !== sig[i]) return false;
    }
    return true;
}

/**
 * Sniffs the true type out of the leading bytes. Only raster image formats are cleared for an inline
 * render; an SVG is identified (`render: "svg"`) but its preview stays a download chip (`decryptFile`
 * / NodeView). PDFs and unknown types fall through to download-only, so a malicious blob can never
 * execute in the app origin.
 */
export function sniffKind(bytes: Uint8Array): SniffedKind {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return { render: "raster", mime: "image/png" };
    }
    // JPEG: FF D8 FF
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
        return { render: "raster", mime: "image/jpeg" };
    }
    // GIF: "GIF87a" / "GIF89a"
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
        return { render: "raster", mime: "image/gif" };
    }
    // WEBP: "RIFF"...."WEBP"
    if (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
    ) {
        return { render: "raster", mime: "image/webp" };
    }
    // ISOBMFF / ftyp (MP4, HEIC, MOV, fragmented MP4, …). Offset 4 = "ftyp", 8 = major brand.
    // The older, narrow allow-list (only mp41/mp42/isom/iso2/avc1) missed common brands
    // (iso5/iso6/dash/hvc1/hev1/qt  …) → sniff "download" → the stream's Content-Type is
    // octet-stream → a <video> error → a silent fallback to the file chip (the player "opens and
    // closes again").
    if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) && bytes.length >= 12) {
        const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
        // Still-image HEIF brands — do not treat them as video.
        const heifImage = new Set([
            "heic",
            "heix",
            "hevc",
            "hevx",
            "heim",
            "heis",
            "hevm",
            "hevs",
            "mif1",
            "msf1",
        ]);
        if (heifImage.has(brand)) {
            return { render: "raster", mime: "image/heic" };
        }
        // Audio-only MP4-family brands.
        if (["M4A ", "M4B ", "F4A "].includes(brand)) {
            return { render: "audio", mime: "audio/mp4" };
        }
        // Everything else carrying an ftyp (unknown and newer brands included) → video/mp4, and let
        // the browser's canPlayType / a media error decide (a decode failure → a chip, not a silent
        // octet-stream).
        return { render: "video", mime: "video/mp4" };
    }
    // SVG (text, looks for "<svg" or "<?xml" near the start)
    const textPrefix = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes.slice(0, 100))
        .trim()
        .toLowerCase();
    if (textPrefix.includes("<svg") || textPrefix.includes("<?xml")) {
        return { render: "svg", mime: "image/svg+xml" };
    }
    // WebM / Matroska: 1A 45 DF A3
    if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
        // Matroska container can be webm, mkv, etc.
        // We'll call it video/webm and let the browser try playing it.
        return { render: "video", mime: "video/webm" };
    }
    // MP3 (ID3 tag): ID3
    if (startsWith(bytes, [0x49, 0x44, 0x33])) {
        return { render: "audio", mime: "audio/mpeg" };
    }
    // OGG: OggS
    if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) {
        return { render: "audio", mime: "audio/ogg" }; // Could be video, but usually audio.
    }
    // Everything else (PDFs, archives, the unknown) — there is no inline render in v1.
    return { render: "download", mime: "application/octet-stream" };
}
