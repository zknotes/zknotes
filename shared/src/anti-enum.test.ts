import { describe, expect, it } from "vitest";
import { generateDeterministicFakeKdfMetadata, PRODUCTION_KDF_PARAMS } from "./cryptography";

describe("Anti-Enumeration", () => {
    it("should generate deterministic fake salt and kdf params for the same email and seed", () => {
        const seed = "static-fake-seed-never-changes-12345678";
        const email = "user@example.com";

        const firstCall = generateDeterministicFakeKdfMetadata(email, seed);
        const secondCall = generateDeterministicFakeKdfMetadata(email, seed);

        expect(firstCall.salt).toEqual(secondCall.salt);
        expect(firstCall.salt.length).toBe(16);
        expect(firstCall.params).toEqual(secondCall.params);
        // The fake params must be PRODUCTION (not DEFAULT_*) so they stay indistinguishable from
        // real accounts in production (DEFAULT drops to weak values in a test build).
        expect(firstCall.params).toEqual(PRODUCTION_KDF_PARAMS);
    });

    it("should generate different fake salts for different emails", () => {
        const seed = "static-fake-seed-never-changes-12345678";
        const email1 = "user1@example.com";
        const email2 = "user2@example.com";

        const metadata1 = generateDeterministicFakeKdfMetadata(email1, seed);
        const metadata2 = generateDeterministicFakeKdfMetadata(email2, seed);

        expect(metadata1.salt).not.toEqual(metadata2.salt);
    });

    it("should generate different fake salts for different seeds", () => {
        const seed1 = "seed1";
        const seed2 = "seed2";
        const email = "user@example.com";

        const metadata1 = generateDeterministicFakeKdfMetadata(email, seed1);
        const metadata2 = generateDeterministicFakeKdfMetadata(email, seed2);

        expect(metadata1.salt).not.toEqual(metadata2.salt);
    });
});
