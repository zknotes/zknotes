import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./upload-chunk-store", () => ({
    loadUploadChunk: vi.fn(),
}));

import { loadUploadChunk } from "./upload-chunk-store";
import { allChunksPresentOnS3, reconcileManifestWithStatus } from "./upload-reconcile";

describe("reconcileManifestWithStatus", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("marks confirmed when manifest entry already confirmed", async () => {
        const result = await reconcileManifestWithStatus(
            "loc-1",
            { 0: { nonce: "n0", hash: "h0", size: 48, local_state: "confirmed" } },
            [0],
        );
        expect(result.fatalIntegrity).toBe(false);
        expect(result.confirmedIndices.has(0)).toBe(true);
        expect(result.manifest[0]?.local_state).toBe("confirmed");
    });

    it("upgrades persisted manifest entry when S3 present", async () => {
        const result = await reconcileManifestWithStatus(
            "loc-1",
            { 0: { nonce: "n0", hash: "h0", size: 48, local_state: "persisted" } },
            [0],
        );
        expect(result.manifest[0]?.local_state).toBe("confirmed");
        expect(result.confirmedIndices.has(0)).toBe(true);
    });

    it("reconstructs manifest from staged chunk when S3 ahead of manifest", async () => {
        vi.mocked(loadUploadChunk).mockResolvedValue({
            key: "loc-1:0",
            pendingLocalId: "loc-1",
            index: 0,
            ciphertext: new Uint8Array([1, 2, 3]),
            nonce: "staged-nonce",
            hash: "staged-hash",
            size: 3,
            storedAt: 1,
        });

        const result = await reconcileManifestWithStatus("loc-1", {}, [0]);

        expect(result.fatalIntegrity).toBe(false);
        expect(result.manifest[0]).toEqual({
            nonce: "staged-nonce",
            hash: "staged-hash",
            size: 3,
            local_state: "confirmed",
        });
    });

    it("returns fatal_integrity when S3 present without manifest or staged chunk", async () => {
        vi.mocked(loadUploadChunk).mockResolvedValue(null);

        const result = await reconcileManifestWithStatus("loc-1", {}, [0]);

        expect(result.fatalIntegrity).toBe(true);
    });

    it("confirmed in manifest but missing on S3 → demote to persisted (re-PUT)", async () => {
        const result = await reconcileManifestWithStatus(
            "loc-1",
            {
                0: { nonce: "n0", hash: "h0", size: 48, local_state: "confirmed" },
                1: { nonce: "n1", hash: "h1", size: 48, local_state: "confirmed" },
            },
            [0], // chunk 0 alone is on S3
        );
        expect(result.fatalIntegrity).toBe(false);
        expect(result.confirmedIndices.has(0)).toBe(true);
        expect(result.confirmedIndices.has(1)).toBe(false);
        expect(result.manifest[1]?.local_state).toBe("persisted");
        expect(result.manifest[0]?.local_state).toBe("confirmed");
    });
});

describe("allChunksPresentOnS3", () => {
    it("requires every index 0..n-1", () => {
        expect(allChunksPresentOnS3([0, 1], 2)).toBe(true);
        expect(allChunksPresentOnS3([0], 2)).toBe(false);
        expect(allChunksPresentOnS3([0, 2], 3)).toBe(false);
    });
});
