import { describe, expect, it } from "vitest";
import { restoreRemapId, restoreRemapIdAt } from "./restore-remap";

// Recorded from the client's implementation before it moved here. A change to any
// of these means a resumed session or a repeated restore of the same file gets different ids.
const VECTORS: Array<{ backupHash: string; oldId: string; remapped: string }> = [
    {
        backupHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        oldId: "01920f3e-7a4b-7c2d-9e1f-0123456789ab",
        remapped: "9e14dfbf-f207-7148-8430-eb83803d59be",
    },
    {
        backupHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        oldId: "11111111-1111-7111-8111-111111111111",
        remapped: "f2a1d553-89ed-7d05-9bea-e5d9887ea835",
    },
    {
        // Upper-case hex is folded to lower case first.
        backupHash: "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824",
        oldId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
        remapped: "2d6bec08-9c64-7d51-ac83-47a75bb6f8b5",
    },
    {
        // Non-hex characters are dropped and the rest is zero-padded — "hash-one" leaves only "ae".
        backupHash: "hash-one",
        oldId: "11111111-1111-7111-8111-111111111111",
        remapped: "bf111111-1111-7111-8111-111111111111",
    },
];

describe("restoreRemapId", () => {
    it.each(VECTORS)("maps $oldId to the recorded id", ({ backupHash, oldId, remapped }) => {
        expect(restoreRemapId(backupHash, oldId)).toBe(remapped);
    });

    it("sets the UUID version 7 and the RFC 4122 variant", () => {
        for (const { backupHash, oldId } of VECTORS) {
            const id = restoreRemapId(backupHash, oldId);
            expect(id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
        }
    });

    it("gives a different id for a different backup, and never the old id itself", () => {
        const [first, second] = VECTORS;
        if (!first || !second) throw new Error("vectors missing");
        const a = restoreRemapId(first.backupHash, first.oldId);
        const b = restoreRemapId(second.backupHash, first.oldId);
        expect(a).not.toBe(b);
        expect(a).not.toBe(first.oldId);
    });
});

describe("restoreRemapIdAt", () => {
    const backupHash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const oldId = "01920f3e-7a4b-7c2d-9e1f-0123456789ab";

    it("generation 0 is restoreRemapId itself", () => {
        expect(restoreRemapIdAt(backupHash, oldId, 0)).toBe(restoreRemapId(backupHash, oldId));
    });

    // Recorded when generations were introduced; a change moves the ids of every later restore.
    it.each([
        [1, "5678c879-7fa5-7890-95be-a83559841ad6"],
        [2, "f7d13197-8b21-7d5e-984e-d543afe8b326"],
        [8, "5fd98534-fa01-7475-bdd4-8585cbada76f"],
    ])("generation %i is pinned", (generation, expected) => {
        expect(restoreRemapIdAt(backupHash, oldId, generation)).toBe(expected);
    });

    it("every generation is a distinct UUIDv7 and never the original", () => {
        const ids = Array.from({ length: 9 }, (_, g) => restoreRemapIdAt(backupHash, oldId, g));
        expect(new Set([...ids, oldId]).size).toBe(ids.length + 1);
        for (const id of ids) {
            expect(id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            );
        }
    });

    it("remapping the remap lands back on the original — why each generation has its own hash", () => {
        expect(restoreRemapId(backupHash, restoreRemapId(backupHash, oldId))).toBe(oldId);
    });
});
