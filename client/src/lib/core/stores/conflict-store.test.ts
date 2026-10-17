import { describe, expect, it } from "vitest";
import { conflictStore } from "./conflict-store.svelte";

function entry(id: string) {
    return { id, title: `T ${id}`, type: "note" as const, at: 1 };
}

describe("conflictStore", () => {
    it("add prepends newest first", () => {
        conflictStore.clear();
        conflictStore.add(entry("a"));
        conflictStore.add(entry("b"));
        expect(conflictStore.recent.map((e) => e.id)).toEqual(["b", "a"]);
    });

    it("caps recent at 20 entries", () => {
        conflictStore.clear();
        for (let i = 0; i < 25; i++) conflictStore.add(entry(`x${i}`));
        expect(conflictStore.recent).toHaveLength(20);
        expect(conflictStore.recent[0]?.id).toBe("x24"); // the newest on top
    });

    it("clear empties the list", () => {
        conflictStore.add(entry("a"));
        conflictStore.clear();
        expect(conflictStore.recent).toEqual([]);
    });

    it("add normalizes millisecond timestamps to unix seconds", () => {
        conflictStore.clear();
        const ms = 1_700_000_000_000;
        conflictStore.add({ ...entry("ms"), at: ms });
        expect(conflictStore.recent[0]?.at).toBe(Math.floor(ms / 1000));
    });
});
