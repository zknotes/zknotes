// Saas spec 159: the one answer to "can this parent take this child" — POST, PUT and the batch
// used to spell the three refusals out each.
import { describe, expect, test } from "bun:test";
import { parentRejection } from "../../src/services/item-service";

const parent = (
    type: string,
    o: Partial<{ deleted_at: number | null; purged_at: number | null }> = {},
) => ({
    type,
    deleted_at: null,
    purged_at: null,
    ...o,
});

describe("parentRejection", () => {
    test("a missing or purged parent is not found", () => {
        expect(parentRejection(undefined, "note", false)).toBe("Parent not found");
        expect(parentRejection(parent("folder", { purged_at: 1 }), "note", false)).toBe(
            "Parent not found",
        );
    });

    test("a trashed parent takes only a child that arrives trashed too", () => {
        expect(parentRejection(parent("folder", { deleted_at: 1 }), "note", false)).toBe(
            "Parent not found",
        );
        expect(parentRejection(parent("folder", { deleted_at: 1 }), "note", true)).toBeNull();
    });

    test("a file hangs under a note, everything else under a folder", () => {
        expect(parentRejection(parent("folder"), "file", false)).toBe("File parent must be a note");
        expect(parentRejection(parent("note"), "file", false)).toBeNull();
        expect(parentRejection(parent("note"), "note", false)).toBe("Parent is not a folder");
        expect(parentRejection(parent("folder"), "folder", false)).toBeNull();
    });
});
