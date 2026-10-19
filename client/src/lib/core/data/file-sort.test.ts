import { describe, expect, it } from "vitest";
import { sortFiles } from "./file-filters";

// Saas spec 156 (package G): the Files page comparator, lifted out of the page so it can be pinned.
const f = (title: string, o: Partial<{ updated_at: number; size: number; mime: string }> = {}) =>
    ({ title, updated_at: 0, ...o }) as Parameters<typeof sortFiles>[0][number];

describe("sortFiles", () => {
    it("by size treats a missing size as 0, both ways", () => {
        const files = [f("a", { size: 5 }), f("b"), f("c", { size: 9 })];
        expect(sortFiles(files, "size_desc").map((x) => x.title)).toEqual(["c", "a", "b"]);
        expect(sortFiles(files, "size_asc").map((x) => x.title)).toEqual(["b", "a", "c"]);
    });

    it("by type groups on mime and breaks ties on the title", () => {
        const files = [
            f("b", { mime: "image/png" }),
            f("a", { mime: "image/png" }),
            f("z", { mime: "application/pdf" }),
        ];
        expect(sortFiles(files, "type_asc").map((x) => x.title)).toEqual(["z", "a", "b"]);
    });

    it("by name is locale-aware (a before B), by date newest first by default", () => {
        const files = [f("B", { updated_at: 1 }), f("a", { updated_at: 2 })];
        expect(sortFiles(files, "name_asc").map((x) => x.title)).toEqual(["a", "B"]);
        expect(sortFiles(files, "updated_desc").map((x) => x.title)).toEqual(["a", "B"]);
        expect(sortFiles(files, "updated_asc").map((x) => x.title)).toEqual(["B", "a"]);
    });

    it("does not mutate its input", () => {
        const files = [f("b", { size: 2 }), f("a", { size: 1 })];
        sortFiles(files, "size_asc");
        expect(files.map((x) => x.title)).toEqual(["b", "a"]);
    });
});
