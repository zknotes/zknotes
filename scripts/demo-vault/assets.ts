/**
 * The binary attachments of the demo vault, generated rather than checked in: a real PNG and a real
 * PDF, small and byte-for-byte reproducible, so the repository carries the recipe and not the blob.
 */

import { crc32, deflateSync } from "node:zlib";

const encoder = new TextEncoder();

/** mulberry32 — a deterministic PRNG, so two runs produce identical files. */
function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export type Rgb = [number, number, number];

/** A tiny RGB canvas with just the primitives the two figures need. */
export class Canvas {
    readonly width: number;
    readonly height: number;
    readonly #pixels: Uint8Array;

    constructor(width: number, height: number, background: Rgb = [255, 255, 255]) {
        this.width = width;
        this.height = height;
        this.#pixels = new Uint8Array(width * height * 3);
        for (let i = 0; i < width * height; i++) {
            this.#pixels[i * 3] = background[0];
            this.#pixels[i * 3 + 1] = background[1];
            this.#pixels[i * 3 + 2] = background[2];
        }
    }

    set(x: number, y: number, [r, g, b]: Rgb): void {
        const px = Math.round(x);
        const py = Math.round(y);
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
        const at = (py * this.width + px) * 3;
        this.#pixels[at] = r;
        this.#pixels[at + 1] = g;
        this.#pixels[at + 2] = b;
    }

    rect(x: number, y: number, w: number, h: number, color: Rgb): void {
        for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, color);
        }
    }

    line(x0: number, y0: number, x1: number, y1: number, color: Rgb, weight = 1): void {
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
        for (let i = 0; i <= steps; i++) {
            const x = x0 + ((x1 - x0) * i) / steps;
            const y = y0 + ((y1 - y0) * i) / steps;
            for (let w = 0; w < weight; w++) this.set(x, y + w, color);
        }
    }

    /** PNG: signature, IHDR, one IDAT of zlib-compressed scanlines with filter 0, IEND. */
    toPng(): Uint8Array {
        const stride = this.width * 3;
        const raw = new Uint8Array(this.height * (stride + 1));
        for (let y = 0; y < this.height; y++) {
            raw[y * (stride + 1)] = 0; // filter: none
            raw.set(this.#pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
        }

        const ihdr = new Uint8Array(13);
        const view = new DataView(ihdr.buffer);
        view.setUint32(0, this.width);
        view.setUint32(4, this.height);
        ihdr[8] = 8; // bit depth
        ihdr[9] = 2; // colour type: truecolour
        return concat([
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            pngChunk("IHDR", ihdr),
            pngChunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
            pngChunk("IEND", new Uint8Array(0)),
        ]);
    }
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = encoder.encode(type);
    const body = concat([typeBytes, data]);
    const out = new Uint8Array(8 + data.byteLength + 4);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.byteLength);
    out.set(body, 4);
    view.setUint32(4 + body.byteLength, crc32(body) >>> 0);
    return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}

/** A perceptually ordered blue→green→yellow ramp, close enough to viridis to read as one. */
function ramp(t: number): Rgb {
    const stops: Rgb[] = [
        [68, 1, 84],
        [59, 82, 139],
        [33, 145, 140],
        [94, 201, 98],
        [253, 231, 37],
    ];
    const clamped = Math.min(0.999, Math.max(0, t));
    const span = clamped * (stops.length - 1);
    const i = Math.floor(span);
    const f = span - i;
    const a = stops[i] as Rgb;
    const b = stops[i + 1] as Rgb;
    return [
        Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f),
    ];
}

/** The intrinsic size of each generated figure, so a note can carry it without decoding the PNG. */
export const HEATMAP_SIZE = { w: 26 + 32 * 13 + 46, h: 16 + 14 * 13 + 22 } as const;
export const COST_TREND_SIZE = { w: 468, h: 190 } as const;

/** Per-tile read depth across a flow cell — the figure the sequencing QC note embeds. */
export function coverageHeatmapPng(): Uint8Array {
    const cols = 32;
    const rows = 14;
    const cell = 13;
    const padLeft = 26;
    const padTop = 16;
    const canvas = new Canvas(
        padLeft + cols * cell + 46,
        padTop + rows * cell + 22,
        [250, 250, 251],
    );
    const random = prng(0x5eed_1234);

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            // A smooth edge-to-centre falloff plus noise: the shape a real flow cell produces.
            const nx = (col / (cols - 1)) * 2 - 1;
            const ny = (row / (rows - 1)) * 2 - 1;
            const value =
                Math.max(0, 1 - 0.85 * (nx * nx * 0.6 + ny * ny)) * (0.82 + random() * 0.3);
            canvas.rect(padLeft + col * cell, padTop + row * cell, cell - 1, cell - 1, ramp(value));
        }
    }

    // The axes and the colour bar.
    const axis: Rgb = [120, 120, 130];
    canvas.line(padLeft - 4, padTop, padLeft - 4, padTop + rows * cell - 1, axis);
    canvas.line(
        padLeft - 4,
        padTop + rows * cell + 2,
        padLeft + cols * cell - 1,
        padTop + rows * cell + 2,
        axis,
    );
    const barX = padLeft + cols * cell + 14;
    for (let y = 0; y < rows * cell; y++) {
        canvas.rect(barX, padTop + y, 12, 1, ramp(1 - y / (rows * cell - 1)));
    }
    return canvas.toPng();
}

/** Monthly platform spend — the figure the cost note embeds. */
export function costTrendPng(): Uint8Array {
    const { w: width, h: height } = COST_TREND_SIZE;
    const left = 34;
    const bottom = height - 26;
    const top = 14;
    const canvas = new Canvas(width, height, [250, 250, 251]);
    const grid: Rgb = [226, 228, 233];
    const axis: Rgb = [120, 120, 130];
    const compute: Rgb = [59, 130, 246];
    const storage: Rgb = [20, 184, 166];

    for (let i = 0; i <= 4; i++) {
        const y = top + ((bottom - top) * i) / 4;
        canvas.line(left, y, width - 14, y, grid);
    }
    canvas.line(left, top, left, bottom, axis);
    canvas.line(left, bottom, width - 14, bottom, axis);

    const computeSeries = [0.42, 0.46, 0.44, 0.51, 0.58, 0.55, 0.63, 0.71, 0.68];
    const storageSeries = [0.18, 0.19, 0.21, 0.22, 0.24, 0.27, 0.29, 0.3, 0.33];
    const plot = (series: number[], color: Rgb) => {
        const step = (width - 14 - left) / (series.length - 1);
        for (let i = 0; i < series.length - 1; i++) {
            const a = series[i] as number;
            const b = series[i + 1] as number;
            canvas.line(
                left + i * step,
                bottom - a * (bottom - top),
                left + (i + 1) * step,
                bottom - b * (bottom - top),
                color,
                2,
            );
        }
        for (let i = 0; i < series.length; i++) {
            const value = series[i] as number;
            canvas.rect(left + i * step - 2, bottom - value * (bottom - top) - 2, 5, 5, color);
        }
    };
    plot(computeSeries, compute);
    plot(storageSeries, storage);

    // A two-entry legend.
    canvas.rect(left + 8, top + 4, 10, 10, compute);
    canvas.rect(left + 92, top + 4, 10, 10, storage);
    return canvas.toPng();
}

/** A single-page PDF — hand-assembled, because a real one is only a few hundred bytes of syntax. */
export function simplePdf(title: string, lines: string[]): Uint8Array {
    const esc = (text: string) => text.replace(/([\\()])/g, "\\$1");
    const body = [
        "BT",
        "/F1 16 Tf",
        "56 780 Td",
        `(${esc(title)}) Tj`,
        "/F2 11 Tf",
        "0 -28 Td",
        ...lines.flatMap((line) => [`(${esc(line)}) Tj`, "0 -16 Td"]),
        "ET",
    ].join("\n");

    const objects = [
        "<</Type/Catalog/Pages 2 0 R>>",
        "<</Type/Pages/Kids[3 0 R]/Count 1>>",
        "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]" +
            "/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>",
        `<</Length ${encoder.encode(body).byteLength}>>\nstream\n${body}\nendstream`,
        "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>",
        "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ];

    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
        offsets.push(encoder.encode(pdf).byteLength);
        pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefAt = encoder.encode(pdf).byteLength;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return encoder.encode(pdf);
}
