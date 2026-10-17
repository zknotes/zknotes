// Client-side thumbnail generation.
// It decodes the image with createImageBitmap, draws it onto an OffscreenCanvas at ≤320×320, and
// encodes it as WebP (falling back to JPEG). It returns null when the image cannot be decoded, when
// OffscreenCanvas is unavailable, or when the output exceeds MAX_BYTES.
const MAX_DIM = 320;
const MAX_BYTES = 32 * 1024;
const QUALITY = 0.75;

/**
 * The result: the thumbnail bytes + the original's intrinsic dimensions. The dimensions are decoded
 * for the scaling anyway, so we return them rather than decoding the image a second time.
 */
export interface ThumbnailResult {
    bytes: Uint8Array;
    width: number;
    height: number;
}

export async function generateThumbnail(blob: Blob): Promise<ThumbnailResult | null> {
    try {
        let width: number;
        let height: number;
        let drawable: CanvasImageSource;

        try {
            if (typeof createImageBitmap !== "undefined") {
                const bmp = await createImageBitmap(blob);
                width = bmp.width;
                height = bmp.height;
                drawable = bmp;
            } else {
                throw new Error("No createImageBitmap");
            }
        } catch {
            // Fall back to <img> for formats such as HEIC on Safari, where createImageBitmap can fail
            const img = new Image();
            const url = URL.createObjectURL(blob);
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = url;
            });
            URL.revokeObjectURL(url);
            width = img.naturalWidth;
            height = img.naturalHeight;
            drawable = img;
        }

        const scale = Math.min(1, MAX_DIM / Math.max(width, height, 1));
        const tw = Math.max(1, Math.round(width * scale));
        const th = Math.max(1, Math.round(height * scale));

        const canvas =
            typeof OffscreenCanvas !== "undefined"
                ? new OffscreenCanvas(tw, th)
                : document.createElement("canvas");

        if (canvas instanceof HTMLCanvasElement) {
            canvas.width = tw;
            canvas.height = th;
        }

        const ctx = canvas.getContext("2d") as
            | CanvasRenderingContext2D
            | OffscreenCanvasRenderingContext2D
            | null;
        if (!ctx) {
            if ("close" in drawable) (drawable as ImageBitmap).close();
            return null;
        }
        ctx.drawImage(drawable, 0, 0, tw, th);
        if ("close" in drawable) (drawable as ImageBitmap).close();

        let out: Blob;
        if (canvas instanceof OffscreenCanvas) {
            out = await canvas.convertToBlob({ type: "image/webp", quality: QUALITY });
            if (out.size > MAX_BYTES)
                out = await canvas.convertToBlob({ type: "image/jpeg", quality: QUALITY });
        } else {
            out = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((b) => (b ? resolve(b) : reject()), "image/webp", QUALITY);
            }).catch(
                () =>
                    new Promise<Blob>((resolve, reject) => {
                        canvas.toBlob((b) => (b ? resolve(b) : reject()), "image/jpeg", QUALITY);
                    }),
            );
        }

        if (out.size > MAX_BYTES) return null;
        return { bytes: new Uint8Array(await out.arrayBuffer()), width, height };
    } catch {
        return null;
    }
}
