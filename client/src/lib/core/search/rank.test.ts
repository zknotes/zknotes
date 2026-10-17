import { describe, expect, it } from "vitest";
import type { DecryptedItemMeta } from "$lib/core/data/items";
import type { SearchHit } from "$lib/core/workers/crypto-rpc";
import { groupByType, mergeHits, type RankedHit, rankTitles, recentItems } from "./rank";

let seq = 0;

function item(title: string, over: Partial<DecryptedItemMeta> = {}): DecryptedItemMeta {
    seq += 1;
    return {
        id: `id-${seq}`,
        type: "note",
        parent_id: null,
        sort_order: "a0",
        title,
        updated_at: seq,
        version: 1,
        ...over,
    };
}

const titlesOf = (hits: readonly RankedHit[]) => hits.map((hit) => hit.title);

describe("rankTitles", () => {
    it("ranks a prefix above a scattered match", () => {
        const items = [item("Server setup guide"), item("Settings"), item("Sales targets")];
        expect(titlesOf(rankTitles("set", items, 5))).toEqual([
            "Settings",
            "Server setup guide",
            "Sales targets",
        ]);
    });

    it("breaks a tie on title length, then on recency", () => {
        const older = item("Notes", { updated_at: 10 });
        const newer = item("Notes", { updated_at: 99 });
        const longer = item("Notes archive", { updated_at: 500 });
        expect(rankTitles("notes", [longer, older, newer], 5).map((hit) => hit.id)).toEqual([
            newer.id,
            older.id,
            longer.id,
        ]);
    });

    it("returns the matched positions for the highlight", () => {
        const [hit] = rankTitles("stg", [item("Staging deploy")], 5);
        expect(hit?.positions).toEqual([0, 1, 3]);
        expect(hit?.contentOnly).toBe(false);
    });

    it("falls back to the Untitled placeholder, and matches against it", () => {
        expect(titlesOf(rankTitles("untit", [item("")], 5))).toEqual(["Untitled"]);
    });

    it("returns nothing for an empty query", () => {
        expect(rankTitles("   ", [item("Settings")], 5)).toEqual([]);
    });

    it("honours the limit", () => {
        const items = Array.from({ length: 20 }, (_, i) => item(`Note ${i}`));
        expect(rankTitles("note", items, 3)).toHaveLength(3);
    });

    it("still finds the best match in a vault far past the scoring budget", () => {
        // 5_000 weak candidates (every one contains s…e…t) plus one exact title. The pre-pass keeps
        // the tightest windows, so the exact match can never be budgeted out.
        const items = Array.from({ length: 5_000 }, (_, i) => item(`Some extra text ${i}`));
        items.splice(2_500, 0, item("Set"));
        expect(titlesOf(rankTitles("set", items, 1))).toEqual(["Set"]);
    });
});

describe("recentItems", () => {
    it("returns the most recently touched items first", () => {
        const items = [
            item("Old", { updated_at: 1 }),
            item("Newest", { updated_at: 300 }),
            item("Middle", { updated_at: 200 }),
        ];
        expect(titlesOf(recentItems(items, 2))).toEqual(["Newest", "Middle"]);
    });

    it("does not mutate the caller's array", () => {
        const items = [item("A", { updated_at: 1 }), item("B", { updated_at: 2 })];
        recentItems(items, 2);
        expect(items.map((entry) => entry.title)).toEqual(["A", "B"]);
    });
});

describe("mergeHits", () => {
    const titleHit = (id: string, title: string): RankedHit => ({
        id,
        type: "note",
        title,
        positions: [],
        contentOnly: false,
    });
    const contentHit = (id: string, title: string): SearchHit => ({
        id,
        type: "note",
        title,
        score: 1,
    });

    it("puts title hits before content-only hits", () => {
        const merged = mergeHits([titleHit("a", "A")], [contentHit("b", "B")], 5);
        expect(merged.map((hit) => [hit.id, hit.contentOnly])).toEqual([
            ["a", false],
            ["b", true],
        ]);
    });

    it("never lists the same item twice", () => {
        const merged = mergeHits([titleHit("a", "A")], [contentHit("a", "A")], 5);
        expect(merged).toHaveLength(1);
        expect(merged[0]?.contentOnly).toBe(false);
    });

    it("reserves room so a permissive title lane cannot bury the content lane", () => {
        const titles = Array.from({ length: 8 }, (_, i) => titleHit(`t${i}`, `T${i}`));
        const merged = mergeHits(titles, [contentHit("c0", "C0"), contentHit("c1", "C1")], 8);
        expect(merged).toHaveLength(8);
        expect(merged.filter((hit) => hit.contentOnly).map((hit) => hit.id)).toEqual(["c0", "c1"]);
    });

    it("gives the reserved slots back when the content lane has nothing new", () => {
        const titles = Array.from({ length: 8 }, (_, i) => titleHit(`t${i}`, `T${i}`));
        expect(mergeHits(titles, [], 8)).toHaveLength(8);
    });
});

describe("groupByType", () => {
    it("groups in order of first appearance, so the best hit stays first", () => {
        const hits: RankedHit[] = [
            { id: "f1", type: "folder", title: "Work", positions: [], contentOnly: false },
            { id: "n1", type: "note", title: "Worklog", positions: [], contentOnly: false },
            { id: "f2", type: "folder", title: "Workshop", positions: [], contentOnly: false },
        ];
        const sections = groupByType(hits);
        expect(sections.map((section) => section.label)).toEqual(["Folders", "Notes"]);
        expect(sections[0]?.hits.map((hit) => hit.id)).toEqual(["f1", "f2"]);
        expect(sections[1]?.hits.map((hit) => hit.id)).toEqual(["n1"]);
    });

    it("returns nothing for no hits", () => {
        expect(groupByType([])).toEqual([]);
    });
});
