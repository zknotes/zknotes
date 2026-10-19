import { describe, expect, it } from "vitest";
import { UI_ZOOM_LEVEL_IDS, UI_ZOOM_LEVELS } from "./ui-zoom-levels";

// The zoom levels used to be written three times (a type union, an id array, the labelled table);
// adding a level meant three edits. One table, everything else derived.
describe("UI zoom levels", () => {
    it("has unique ids, in the order the pickers show them, with auto first", () => {
        expect(UI_ZOOM_LEVEL_IDS[0]).toBe("auto");
        expect(new Set(UI_ZOOM_LEVEL_IDS).size).toBe(UI_ZOOM_LEVELS.length);
        expect(UI_ZOOM_LEVEL_IDS).toEqual(UI_ZOOM_LEVELS.map((l) => l.id));
    });

    it("labels every numeric level as a percentage", () => {
        for (const level of UI_ZOOM_LEVELS) {
            if (level.id === "auto") continue;
            expect(level.label).toBe(`${level.id}%`);
        }
    });
});
