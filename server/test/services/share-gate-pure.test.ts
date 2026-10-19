// Saas spec 156 (package G): the two pure predicates of the share gate, pinned directly.
import { describe, expect, test } from "bun:test";
import { hashViewProof, isShareActive, viewProofMatches } from "../../src/services/share-gate";
import type { shareLinks } from "../../src/db/schema";

type ShareRow = typeof shareLinks.$inferSelect;
const NOW = 1_800_000_000;
const share = (o: Partial<ShareRow>): ShareRow =>
    ({ revoked_at: null, expires_at: null, ...o }) as ShareRow;

describe("isShareActive", () => {
    test("a link is active until it is revoked or strictly past its expiry", () => {
        expect(isShareActive(share({}), NOW)).toBe(true);
        expect(isShareActive(share({ expires_at: NOW }), NOW)).toBe(true);
        expect(isShareActive(share({ expires_at: NOW - 1 }), NOW)).toBe(false);
        expect(isShareActive(share({ revoked_at: NOW - 10 }), NOW)).toBe(false);
    });
});

describe("viewProofMatches", () => {
    test("a share with no stored hash never opens; a missing or wrong proof does not match", () => {
        const proof = Buffer.alloc(32, 9).toString("base64");
        const stored = hashViewProof(proof);
        expect(viewProofMatches(null, proof)).toBe(false);
        expect(viewProofMatches(stored, undefined)).toBe(false);
        expect(viewProofMatches(stored, Buffer.alloc(32, 8).toString("base64"))).toBe(false);
        expect(viewProofMatches(stored, "not base64 at all")).toBe(false);
        expect(viewProofMatches(stored, proof)).toBe(true);
    });
});
