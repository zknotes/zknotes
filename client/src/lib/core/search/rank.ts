/**
 * Ranking and merging for the command palette.
 *
 * Two lanes feed it and they are deliberately different:
 *   - titles  — fuzzyMatch(), on the main thread, over the tree items that are already decrypted
 *   - content — MiniSearch, inside the crypto SharedWorker, where the note bodies live
 *
 * A title hit always outranks a content-only hit: the scores of the two lanes are on different
 * scales and are never compared with each other.
 */

import type { DecryptedItemMeta } from "$lib/core/data/items";
import type { SearchHit } from "$lib/core/workers/crypto-rpc";
import { fuzzyMatch, matchSpan, prepareQuery } from "./fuzzy";

export type ItemKind = "note" | "folder" | "file";

export interface RankedHit {
    id: string;
    type: ItemKind;
    title: string;
    /** Matched character positions in `title`; empty when the item matched through its content. */
    positions: number[];
    /** true when the title did not match at all and only the note body did. */
    contentOnly: boolean;
}

/** The title shown for an item whose own title is empty — it is matched against, too. */
export const UNTITLED = "Untitled";

interface ScoredTitle {
    item: DecryptedItemMeta;
    score: number;
    positions: number[];
}

/**
 * Best match first. The score decides; length breaks a tie (a shorter title is the more specific
 * one), and recency breaks what is left — which is what separates equally scattered matches such
 * as "stg" against Storage / Staging / Settings.
 */
function byRelevance(a: ScoredTitle, b: ScoredTitle): number {
    if (b.score !== a.score) return b.score - a.score;
    const lengthA = (a.item.title || UNTITLED).length;
    const lengthB = (b.item.title || UNTITLED).length;
    if (lengthA !== lengthB) return lengthA - lengthB;
    return b.item.updated_at - a.item.updated_at;
}

function toHit(scored: ScoredTitle): RankedHit {
    return {
        id: scored.item.id,
        type: scored.item.type,
        title: scored.item.title || UNTITLED,
        positions: scored.positions,
        contentOnly: false,
    };
}

/**
 * How many candidates get the full O(query × window) scoring. A vault holds up to ITEM_LIMITS
 * items, and a short query is a subsequence of almost all of them, so the pre-pass narrows the
 * field by match tightness first — every exact, prefix and word-prefix match has the tightest
 * possible span, so none of them can be cut here.
 */
const MAX_SCORED = 400;
const MAX_SPAN_BUCKET = 255;

/** Picks the `k` candidates with the tightest windows, by counting sort — no O(n log n) sort. */
function tightest(candidates: number[], spans: number[], k: number): number[] {
    const counts = new Int32Array(MAX_SPAN_BUCKET + 1);
    for (const span of spans) counts[Math.min(span, MAX_SPAN_BUCKET)]! += 1;

    let threshold = 0;
    let running = 0;
    for (; threshold < MAX_SPAN_BUCKET; threshold++) {
        running += counts[threshold]!;
        if (running >= k) break;
    }

    // Everything strictly tighter than the threshold is taken first — there are fewer than `k` of
    // those by construction. Only the one bucket that crosses the budget is then cut in item order,
    // so a tight match late in the tree can never lose its slot to a loose one near the front.
    const picked: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
        if (Math.min(spans[i]!, MAX_SPAN_BUCKET) < threshold) picked.push(candidates[i]!);
    }
    for (let i = 0; i < candidates.length && picked.length < k; i++) {
        if (Math.min(spans[i]!, MAX_SPAN_BUCKET) === threshold) picked.push(candidates[i]!);
    }
    return picked;
}

/** Runs the fuzzy title lane over the live tree items. */
export function rankTitles(
    query: string,
    items: readonly DecryptedItemMeta[],
    limit: number,
): RankedHit[] {
    const q = query.trim();
    if (!q) return [];

    // Pass 1 — reject what cannot match, and measure how tight the rest are. No allocation per item.
    const prepared = prepareQuery(q);
    const candidates: number[] = [];
    const spans: number[] = [];
    for (let i = 0; i < items.length; i++) {
        const span = matchSpan(prepared, items[i]!.title || UNTITLED);
        if (span >= 0) {
            candidates.push(i);
            spans.push(span);
        }
    }

    // Pass 2 — score the survivors properly.
    const scoreList =
        candidates.length <= MAX_SCORED ? candidates : tightest(candidates, spans, MAX_SCORED);
    const scored: ScoredTitle[] = [];
    for (const index of scoreList) {
        const item = items[index]!;
        const match = fuzzyMatch(q, item.title || UNTITLED);
        if (match) scored.push({ item, score: match.score, positions: match.positions });
    }
    scored.sort(byRelevance);
    return scored.slice(0, limit).map(toHit);
}

/** What the palette shows before anything is typed — the most recently touched items. */
export function recentItems(items: readonly DecryptedItemMeta[], limit: number): RankedHit[] {
    return [...items]
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, limit)
        .map((item) => ({
            id: item.id,
            type: item.type,
            title: item.title || UNTITLED,
            positions: [],
            contentOnly: false,
        }));
}

/**
 * Title hits first, then the content-only ones in the worker's own relevance order.
 *
 * A subsequence match is permissive, so the title lane alone can easily fill the whole list and
 * bury a note whose *body* is the real answer. `reserve` keeps that many slots for the content lane
 * whenever it actually has something the titles did not already cover.
 */
export function mergeHits(
    titleHits: readonly RankedHit[],
    contentHits: readonly SearchHit[],
    limit: number,
    reserve = 2,
): RankedHit[] {
    const fromTitles = new Set(titleHits.map((hit) => hit.id));
    const contentOnly = contentHits.filter((hit) => !fromTitles.has(hit.id));
    const reserved = Math.min(reserve, contentOnly.length);

    const merged = titleHits.slice(0, Math.max(1, limit - reserved));
    for (const hit of contentOnly) {
        if (merged.length >= limit) break;
        merged.push({
            id: hit.id,
            type: hit.type,
            title: hit.title || UNTITLED,
            positions: [],
            contentOnly: true,
        });
    }
    return merged;
}

export interface HitSection {
    kind: ItemKind;
    label: string;
    hits: RankedHit[];
}

const SECTION_LABELS: Record<ItemKind, string> = {
    note: "Notes",
    folder: "Folders",
    file: "Files",
};

/**
 * Groups an already ordered list into per-type sections, in order of first appearance — so the
 * single best hit stays the first row, and the section order never contradicts the ranking. The two
 * lanes' scores are on different scales, which is exactly why this cannot sort by score instead.
 */
export function groupByType(hits: readonly RankedHit[]): HitSection[] {
    const sections: HitSection[] = [];
    const byKind = new Map<ItemKind, HitSection>();
    for (const hit of hits) {
        let section = byKind.get(hit.type);
        if (!section) {
            section = { kind: hit.type, label: SECTION_LABELS[hit.type], hits: [] };
            byKind.set(hit.type, section);
            sections.push(section);
        }
        section.hits.push(hit);
    }
    return sections;
}
