// The silent image downscale: it works on the PLAINTEXT bitmap, before encryption, with no UI.
// `createImageBitmap` → `OffscreenCanvas` → `convertToBlob`. It only shrinks (never upscales), and
// anything that cannot be rasterised safely (a non-image, a GIF, an SVG) is left untouched so the
// caller uploads the original. The editor's drop/paste path and the explicit Upload button both use
// it.

const MAX_DIM = 2048;
const QUALITY = 0.9;

function swapExtension(name: string, mime: string): string {
    const ext = mime === "image/png" ? "png" : "webp";
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    return `${base}.${ext}`;
}

/**
 * Returns a downscaled copy when the image is larger than MAX_DIM on its longer side; otherwise (or
 * for any format we do not rasterise, or cannot decode) it returns the original file unchanged.
 */
export async function downscaleImage(file: File): Promise<File> {
    // Non-raster, or formats we must not flatten: an animated GIF, a vector SVG → upload as-is.
    if (
        !file.type.startsWith("image/") ||
        file.type === "image/gif" ||
        file.type === "image/svg+xml"
    ) {
        return file;
    }

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        return file; // undecodable → let the original through the pipeline
    }

    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_DIM / Math.max(width, height));
    if (scale >= 1) {
        bitmap.close();
        return file; // already within the bounds
    }

    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        bitmap.close();
        return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    // Keep the transparency for PNG sources; everything else compresses well as WebP.
    const outType = file.type === "image/png" ? "image/png" : "image/webp";
    const blob = await canvas.convertToBlob({ type: outType, quality: QUALITY });
    return new File([blob], swapExtension(file.name, outType), { type: outType });
}
