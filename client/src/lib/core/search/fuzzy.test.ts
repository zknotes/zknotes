import { describe, expect, it } from "vitest";
import { foldDiacritics, fuzzyMatch, highlightSegments, matchSpan, prepareQuery } from "./fuzzy";

const score = (query: string, target: string) => fuzzyMatch(query, target)?.score ?? Number.NaN;

/** Renders a match the way the palette does, so the expectations stay readable. */
function marked(query: string, target: string): string {
    const match = fuzzyMatch(query, target);
    if (!match) return "";
    return highlightSegments(target, match.positions)
        .map((segment) => (segment.hit ? `[${segment.text}]` : segment.text))
        .join("");
}

describe("fuzzyMatch — subsequence", () => {
    it("matches an abbreviation MiniSearch cannot reach", () => {
        expect(marked("stg", "Staging deploy")).toBe("[St]a[g]ing deploy");
        expect(marked("dckr", "Docker compose notes")).toBe("[D]o[ck]e[r] compose notes");
    });

    it("rejects characters that are not present, and out-of-order queries", () => {
        expect(fuzzyMatch("zzz", "Staging deploy")).toBeNull();
        expect(fuzzyMatch("compose docker", "Docker compose")).toBeNull();
    });

    it("rejects an empty query or target", () => {
        expect(fuzzyMatch("", "Anything")).toBeNull();
        expect(fuzzyMatch("   ", "Anything")).toBeNull();
        expect(fuzzyMatch("a", "")).toBeNull();
    });
});

describe("fuzzyMatch — ranking tiers", () => {
    it("puts a prefix above a scattered match", () => {
        expect(score("set", "Settings")).toBeGreaterThan(score("set", "Server setup guide"));
    });

    it("puts an exact title above a prefix of a longer one", () => {
        expect(score("settings", "Settings")).toBeGreaterThan(
            score("settings", "Settings archive"),
        );
    });

    it("puts a word prefix above a scattered match", () => {
        expect(score("setup", "Server setup guide")).toBeGreaterThan(
            score("setup", "Send the pup"),
        );
    });

    it("recognises initials", () => {
        // "Query the passport" spells q…p too, but not as the initials of its words.
        expect(score("qp", "Quarterly planning")).toBeGreaterThan(
            score("qp", "Query the passport"),
        );
    });

    it("prefers the typed case", () => {
        expect(score("PR", "PR review checklist")).toBeGreaterThan(score("PR", "prices.csv"));
    });

    it("rewards an unbroken run over scattered characters", () => {
        expect(score("ing", "Ingest")).toBeGreaterThan(score("ing", "I am not good"));
    });

    it("scores a camelCase hump like a word start", () => {
        expect(marked("mnf", "myNoteFile")).toBe("[m]y[N]ote[F]ile");
    });
});

describe("fuzzyMatch — diacritics", () => {
    it("reaches Croatian letters from their plain spelling", () => {
        expect(marked("sismis", "Šišmiš bilješke")).toBe("[Šišmiš] bilješke");
        expect(marked("cev", "Ćevapi recept")).toBe("[Ćev]api recept");
        expect(marked("zaba", "Žaba")).toBe("[Žaba]");
    });

    it("accepts every spelling of đ", () => {
        expect(marked("djakovo", "Đakovo izlet")).toBe("[Đakovo] izlet");
        expect(marked("dakovo", "Đakovo izlet")).toBe("[Đakovo] izlet");
        expect(marked("đakovo", "Đakovo izlet")).toBe("[Đakovo] izlet");
    });

    it("folds without losing the mapping back to the source", () => {
        const folded = foldDiacritics("Šišmiš");
        expect(folded.text).toBe("Sismis");
        expect(folded.origin).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("skips the mapping entirely for plain ASCII", () => {
        expect(foldDiacritics("Settings")).toEqual({ text: "Settings", origin: null });
    });
});

describe("highlightSegments", () => {
    it("always reconstructs the original text", () => {
        for (const [query, target] of [
            ["sismis", "Šišmiš bilješke"],
            ["djakovo", "Đakovo izlet"],
            ["stg", "Staging deploy"],
            ["a", "🚀 launch"],
        ] as const) {
            const match = fuzzyMatch(query, target);
            expect(match, `${query} / ${target}`).not.toBeNull();
            const rebuilt = highlightSegments(target, match!.positions)
                .map((segment) => segment.text)
                .join("");
            expect(rebuilt).toBe(target);
        }
    });

    it("returns one plain segment when nothing matched", () => {
        expect(highlightSegments("Plain", [])).toEqual([{ text: "Plain", hit: false }]);
        expect(highlightSegments("", [])).toEqual([]);
    });
});

describe("matchSpan — the pre-pass", () => {
    const corpus = [
        "Settings",
        "Staging deploy",
        "Docker compose notes",
        "Šišmiš bilješke",
        "Đakovo izlet",
        "myNoteFile",
        "prices.csv",
        "Meeting notes — standup",
        "🚀 launch checklist",
        "Đ", // shorter than the query it still matches, because đ expands to "dj"
    ];
    const queries = [
        "s",
        "stg",
        "dckr",
        "sismis",
        "djakovo",
        "dakovo",
        "mnf",
        "notes",
        "zzz",
        "launch",
        "Settings",
        "dj",
    ];

    // rank.ts drops every candidate the pre-pass rejects, so a false negative here silently loses
    // a real result. The pre-pass is allowed to over-accept, never to under-accept.
    it("never rejects anything fuzzyMatch would accept", () => {
        for (const query of queries) {
            const prepared = prepareQuery(query);
            for (const target of corpus) {
                if (fuzzyMatch(query, target)) {
                    expect(
                        matchSpan(prepared, target),
                        `${query} / ${target}`,
                    ).toBeGreaterThanOrEqual(0);
                }
            }
        }
    });

    it("reports the tightest possible span for a prefix", () => {
        expect(matchSpan(prepareQuery("set"), "Settings")).toBe(3);
    });

    it("returns -1 for an impossible query", () => {
        expect(matchSpan(prepareQuery("zzz"), "Settings")).toBe(-1);
        expect(matchSpan(prepareQuery("settingsx"), "Settings")).toBe(-1);
    });
});
