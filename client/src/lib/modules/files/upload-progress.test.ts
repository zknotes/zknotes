import { describe, expect, it } from "vitest";
import { computeUploadDisplayPct } from "./upload";

describe("computeUploadDisplayPct", () => {
    it("returns null when totalChunks is unknown", () => {
        expect(
            computeUploadDisplayPct({ phase: "encrypting", chunkIndex: 0, totalChunks: 0 }),
        ).toBe(null);
        expect(computeUploadDisplayPct({ phase: "uploading" })).toBe(null);
    });

    it("counts encrypting as 0% of the current chunk (no ahead-of-wire jump)", () => {
        // 40 chunks: encrypting chunk 0 must stay at 0%, not 1/40 as if done
        expect(
            computeUploadDisplayPct({
                phase: "encrypting",
                chunkIndex: 0,
                totalChunks: 40,
                chunkPct: 0,
            }),
        ).toBe(0);
        // After 5 confirmed chunks, encrypting #5 still shows 5/40
        expect(
            computeUploadDisplayPct({
                phase: "encrypting",
                chunkIndex: 5,
                totalChunks: 40,
                chunkPct: 0,
            }),
        ).toBe(13);
    });

    it("does not snap back when upload of a chunk starts after encrypt", () => {
        const total = 10;
        const encryptPct = computeUploadDisplayPct({
            phase: "encrypting",
            chunkIndex: 3,
            totalChunks: total,
            chunkPct: 0,
        });
        const uploadStartPct = computeUploadDisplayPct({
            phase: "uploading",
            chunkIndex: 3,
            totalChunks: total,
            chunkPct: 0,
        });
        expect(encryptPct).toBe(uploadStartPct);
        expect(encryptPct).toBe(30);
    });

    it("monotonically increases while a single-chunk PUT progresses", () => {
        const samples = [0, 25, 50, 75, 100].map((chunkPct) =>
            computeUploadDisplayPct({
                phase: "uploading",
                chunkIndex: 0,
                totalChunks: 1,
                chunkPct,
            }),
        );
        expect(samples).toEqual([0, 25, 50, 75, 100]);
        for (let i = 1; i < samples.length; i++) {
            expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
        }
    });

    it("blends multi-chunk upload fraction into overall pct", () => {
        // chunk 1 of 4 at 50% → (1*100 + 50) / 4 = 37.5 → 38
        expect(
            computeUploadDisplayPct({
                phase: "uploading",
                chunkIndex: 1,
                totalChunks: 4,
                chunkPct: 50,
            }),
        ).toBe(38);
    });

    it("shows 100% during finalizing / committing / done", () => {
        for (const phase of ["finalizing", "committing", "done"] as const) {
            expect(
                computeUploadDisplayPct({
                    phase,
                    chunkIndex: 3,
                    totalChunks: 10,
                    chunkPct: 0,
                }),
            ).toBe(100);
        }
    });
});
