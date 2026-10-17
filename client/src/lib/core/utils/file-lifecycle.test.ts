import { describe, expect, it } from "vitest";
import { type FileAction, FileLifecycle, type FileState } from "./file-lifecycle";

const STATES: FileState[] = ["READY", "TRASHED", "DELETED"];
const ACTIONS: FileAction[] = ["trash", "restore", "hardDelete", "crop", "rename", "move"];

describe("FileLifecycle.stateOf", () => {
    it("READY when neither deleted_at nor purged_at is set", () => {
        expect(FileLifecycle.stateOf({})).toBe("READY");
        expect(FileLifecycle.stateOf({ deleted_at: null, purged_at: null })).toBe("READY");
        expect(FileLifecycle.stateOf({ deleted_at: undefined, purged_at: undefined })).toBe(
            "READY",
        );
    });

    it("TRASHED when deleted_at is set and purged_at is not", () => {
        expect(FileLifecycle.stateOf({ deleted_at: 1700000000 })).toBe("TRASHED");
        expect(FileLifecycle.stateOf({ deleted_at: 1700000000, purged_at: null })).toBe("TRASHED");
    });

    it("DELETED when purged_at is set", () => {
        expect(FileLifecycle.stateOf({ purged_at: 1700000000 })).toBe("DELETED");
        expect(FileLifecycle.stateOf({ deleted_at: null, purged_at: 1700000000 })).toBe("DELETED");
    });

    it("purged_at wins over deleted_at (the discriminator) — DELETED, not TRASHED", () => {
        expect(FileLifecycle.stateOf({ deleted_at: 111, purged_at: 222 })).toBe("DELETED");
    });
});

describe("FileLifecycle.can — the full state × action matrix", () => {
    // The only allowed pairs; everything else must be false.
    const ALLOWED = new Set<string>([
        "READY:trash",
        "READY:crop",
        "READY:rename",
        "READY:move",
        "TRASHED:restore",
        "TRASHED:hardDelete",
    ]);

    for (const from of STATES) {
        for (const action of ACTIONS) {
            const expected = ALLOWED.has(`${from}:${action}`);
            it(`can(${from}, ${action}) === ${expected}`, () => {
                expect(FileLifecycle.can(from, action)).toBe(expected);
            });
        }
    }

    it("DELETED is terminal — no action is allowed", () => {
        for (const action of ACTIONS) {
            expect(FileLifecycle.can("DELETED", action)).toBe(false);
        }
    });

    it("guard: crop/rename/move are allowed on neither TRASHED nor DELETED", () => {
        for (const from of ["TRASHED", "DELETED"] as FileState[]) {
            for (const action of ["crop", "rename", "move"] as FileAction[]) {
                expect(FileLifecycle.can(from, action)).toBe(false);
            }
        }
    });
});

describe("FileLifecycle.transition", () => {
    it("returns the right target state for the allowed transitions", () => {
        expect(FileLifecycle.transition("READY", "trash")).toBe("TRASHED");
        expect(FileLifecycle.transition("TRASHED", "restore")).toBe("READY");
        expect(FileLifecycle.transition("TRASHED", "hardDelete")).toBe("DELETED");
    });

    it("the READY-only mutations do not change the state (READY → READY)", () => {
        expect(FileLifecycle.transition("READY", "crop")).toBe("READY");
        expect(FileLifecycle.transition("READY", "rename")).toBe("READY");
        expect(FileLifecycle.transition("READY", "move")).toBe("READY");
    });

    it("throws on every disallowed transition (the complement of the matrix)", () => {
        for (const from of STATES) {
            for (const action of ACTIONS) {
                if (FileLifecycle.can(from, action)) continue;
                expect(() => FileLifecycle.transition(from, action)).toThrow(
                    /Illegal file transition/,
                );
            }
        }
    });

    it("`can` and `transition` agree for every pair", () => {
        for (const from of STATES) {
            for (const action of ACTIONS) {
                if (FileLifecycle.can(from, action)) {
                    expect(() => FileLifecycle.transition(from, action)).not.toThrow();
                } else {
                    expect(() => FileLifecycle.transition(from, action)).toThrow();
                }
            }
        }
    });
});
