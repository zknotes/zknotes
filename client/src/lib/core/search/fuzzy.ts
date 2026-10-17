/**
 * The subsequence matcher behind the command palette's title lane — an fzf-style scorer.
 *
 * MiniSearch, which still owns note *content*, is term based: it tolerates typos through an edit
 * distance, but it structurally cannot match "stg" against "Settings", because the query is neither
 * a term, nor a prefix of one, nor within one edit of one. This module fills exactly that gap, and
 * it only ever sees item titles — which the main thread already holds decrypted for the tree — so it
 * adds no surface to the crypto trust boundary.
 *
 * Out-of-order queries ("compose docker") deliberately do NOT match here; the MiniSearch lane
 * already indexes titles as terms and covers that case.
 */

const COMBINING = /[\u0300-\u036f]/g;
const NON_ASCII = /[\u0080-\uffff]/;

/**
 * Single-character folds, precomputed once. `normalize("NFD")` is far too slow to call per
 * character on every keystroke — this table covers Latin-1 Supplement, Latin Extended-A/B and
 * Latin Extended Additional (Vietnamese included), which is every accented letter a title
 * realistically holds. Anything outside it is left alone.
 */
const FOLD_TABLE: Map<string, string> = (() => {
    const table = new Map<string, string>();
    for (const [from, to] of [
        [0x00c0, 0x024f],
        [0x1e00, 0x1eff],
    ] as const) {
        for (let code = from; code <= to; code++) {
            const ch = String.fromCharCode(code);
            const folded = ch.normalize("NFD").replace(COMBINING, "");
            if (folded !== ch && folded.length > 0) table.set(ch, folded);
        }
    }
    return table;
})();

/** The one list of characters that end a word — the boundary bonus and the tiers share it. */
const SEPARATOR_CHARS = [
    " ",
    "\t",
    "/",
    "\\",
    "-",
    "_",
    ".",
    ",",
    ":",
    ";",
    "(",
    "[",
    "{",
    "—",
    "–",
];
const SEPARATORS = new Set(SEPARATOR_CHARS);
const WORD_SPLIT = new RegExp(
    `[${SEPARATOR_CHARS.map((ch) => ch.replace(/[\\\]^-]/g, "\\$&")).join("")}]+`,
);

// ── Scoring weights ────────────────────────────────────────────────────────────
// Modelled on fzf's v2 algorithm: a match is worth a fixed amount, and the bonuses decide *where*
// in the target the matched characters should land — word starts beat the middle of a word, and an
// unbroken run beats scattered letters.
const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 8; // the character right after a separator
const BONUS_CAMEL = 7; // a lowercase→uppercase hump, as in "myNote"
const BONUS_CONSECUTIVE = 8; // this character continues an unbroken run
const BONUS_FIRST_CHAR_MULTIPLIER = 2; // where the match starts matters twice as much
const PENALTY_GAP_START = -3;
const PENALTY_GAP_EXTRA = -1;
const CASE_BONUS = 3; // the typed case matched the title's case exactly

// A tier is added on top of the character score so that a structural match can never lose to a
// scattered one: "set" must put "Settings" above "Server setup guide", whatever the bonuses say.
const TIER_EXACT = 10_000;
const TIER_PREFIX = 5_000;
const TIER_WORD_PREFIX = 2_500;
const TIER_INITIALS = 1_200; // "qp" → "Quarterly planning"

/**
 * The DP is O(query × window). Titles are not length limited, so a pathological one is matched on
 * its first N characters only — a prefix, so the reported positions stay valid.
 */
const MAX_TARGET = 512;

const NOT_MATCHED = -1_000_000;

export interface FoldedText {
    /** The diacritic-free text. */
    text: string;
    /**
     * origin[i] = the code-unit index in the source string that folded index `i` came from.
     * null when the fold was the identity, so no mapping had to be built.
     */
    origin: number[] | null;
}

/**
 * Strips diacritics so "sismis" reaches "Šišmiš" — MiniSearch's edit distance only covers that by
 * accident, when at most one character differs.
 *
 * `đ` has no canonical decomposition and two spellings in practice, so it is handled explicitly and
 * asymmetrically: a TARGET expands it to "dj" while a QUERY contracts it to "d". Because the match
 * is a subsequence, expanding the target then accepts "đakovo", "djakovo" AND "dakovo" for
 * "Đakovo" — contracting both sides would reject the "dj" spelling.
 *
 * The origin map exists because folding does not preserve length, and the matched positions have to
 * be reported against the ORIGINAL string for the highlight.
 */
export function foldDiacritics(src: string, expandDigraphs = false): FoldedText {
    // The overwhelmingly common case: nothing to fold, so nothing to allocate or remap.
    if (!NON_ASCII.test(src)) return { text: src, origin: null };

    let text = "";
    const origin: number[] = [];
    let offset = 0;
    for (const ch of src) {
        let folded: string;
        if (ch === "đ") folded = expandDigraphs ? "dj" : "d";
        else if (ch === "Đ") folded = expandDigraphs ? "Dj" : "D";
        else folded = FOLD_TABLE.get(ch) ?? ch;
        for (let k = 0; k < folded.length; k++) {
            text += folded[k];
            origin.push(offset);
        }
        offset += ch.length;
    }
    return { text, origin };
}

/**
 * Folded, lowercased character codes for the pre-pass — one Int32Array lookup instead of a string
 * allocation per candidate. -1 means "cannot be reduced to a single character" (`đ`, which a target
 * expands to "dj", or a script outside the table); the pre-pass then treats it as a wildcard, which
 * over-accepts but can never reject a real match.
 */
const FOLD_CODE: Int32Array = (() => {
    const codes = new Int32Array(0x2000);
    for (let code = 0; code < codes.length; code++) {
        const ch = String.fromCharCode(code);
        const folded = (FOLD_TABLE.get(ch) ?? ch).toLowerCase();
        codes[code] = folded.length === 1 ? folded.charCodeAt(0) : -1;
    }
    codes[0x0111] = -1; // đ
    codes[0x0110] = -1; // Đ
    return codes;
})();

/** Folds and lowercases a query once per keystroke, for matchSpan. */
export function prepareQuery(query: string): string {
    return foldDiacritics(query.trim()).text.toLowerCase();
}

/**
 * The allocation-free pre-pass: is `prepared` a subsequence of `target`, and how tight is the
 * window holding it? Returns -1 when it cannot match at all.
 *
 * A smaller span means a tighter match — an exact prefix scores the minimum possible span — so
 * rank.ts can use it to decide which candidates are worth the full O(query × window) scoring in a
 * vault far too large to score exhaustively on every keystroke.
 */
export function matchSpan(prepared: string, target: string): number {
    const m = prepared.length;
    if (m === 0) return -1;
    // No `m > n` shortcut: a target grows when its `đ` expands, so a query can legitimately be
    // longer than the raw target. The forward scan below settles it either way.
    const n = Math.min(target.length, MAX_TARGET);

    let qi = 0;
    let end = -1;
    for (let i = 0; i < n; i++) {
        const code = target.charCodeAt(i);
        const folded = code < 0x2000 ? FOLD_CODE[code]! : -1;
        if (folded === -1) {
            // A wildcard covers one query character — and `đ`, which is why it is a wildcard at
            // all, covers the whole "dj" digraph when the query spells it out.
            qi++;
            if (isDStroke(code) && qi < m && isDigraphDj(prepared, qi - 1)) qi++;
        } else if (folded === prepared.charCodeAt(qi)) {
            qi++;
        } else {
            continue;
        }
        if (qi >= m) {
            end = i + 1;
            break;
        }
    }
    if (end < 0) return -1;

    qi = m - 1;
    let start = 0;
    for (let i = end - 1; i >= 0; i--) {
        const code = target.charCodeAt(i);
        const folded = code < 0x2000 ? FOLD_CODE[code]! : -1;
        if (folded === -1) {
            qi--;
            if (isDStroke(code) && qi >= 0 && isDigraphDj(prepared, qi)) qi--;
        } else if (folded === prepared.charCodeAt(qi)) {
            qi--;
        } else {
            continue;
        }
        if (qi < 0) {
            start = i;
            break;
        }
    }
    return end - start;
}

const CHAR_D = 100;
const CHAR_J = 106;

function isDStroke(code: number): boolean {
    return code === 0x0110 || code === 0x0111;
}

function isDigraphDj(prepared: string, at: number): boolean {
    return prepared.charCodeAt(at) === CHAR_D && prepared.charCodeAt(at + 1) === CHAR_J;
}

export interface FuzzyMatch {
    score: number;
    /** Code-unit indices into the ORIGINAL target of the matched characters, ascending. */
    positions: number[];
}

// The DP buffers are module-level and grown on demand: a palette keystroke scores hundreds of
// candidates, and allocating two typed arrays per candidate dominated the profile.
let scoreBuf = new Int32Array(0);
let runBuf = new Int32Array(0);

function ensureBuffers(size: number): void {
    if (scoreBuf.length < size) {
        scoreBuf = new Int32Array(size);
        runBuf = new Int32Array(size);
    }
}

/**
 * Scores `query` against `target`, or returns null when the query is not a subsequence of it.
 * A higher score is a better match; scores are only comparable within one query.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
    const raw = query.trim();
    if (!raw || !target) return null;

    const foldedQuery = foldDiacritics(raw);
    const foldedTarget = foldDiacritics(
        target.length > MAX_TARGET ? target.slice(0, MAX_TARGET) : target,
        true,
    );
    const q = foldedQuery.text.toLowerCase();
    const cased = foldedTarget.text;
    const t = cased.toLowerCase();
    const m = q.length;
    if (m === 0 || m > t.length) return null;

    // Narrow to the smallest window that still contains a full match (fzf's forward/backward pass).
    // Everything outside it is irrelevant to the score and would only cost DP cells.
    let qi = 0;
    let end = -1;
    for (let i = 0; i < t.length; i++) {
        if (t[i] === q[qi]) {
            qi++;
            if (qi === m) {
                end = i + 1;
                break;
            }
        }
    }
    if (end < 0) return null;

    let start = 0;
    qi = m - 1;
    for (let i = end - 1; i >= 0; i--) {
        if (t[i] === q[qi]) {
            qi--;
            if (qi < 0) {
                start = i;
                break;
            }
        }
    }
    const n = end - start;
    if (n < m) return null;

    ensureBuffers(m * n);

    for (let k = 0; k < m; k++) {
        const row = k * n;
        const prevRow = row - n;
        for (let i = k; i < n; i++) {
            const abs = start + i;
            let best = NOT_MATCHED;
            let run = 0;

            if (t[abs] === q[k]) {
                const inherited = k === 0 ? 0 : scoreBuf[prevRow + i - 1]!;
                if (k === 0 || inherited > NOT_MATCHED / 2) {
                    const previousRun = k === 0 ? 0 : runBuf[prevRow + i - 1]!;
                    let bonus = charBonus(cased, abs);
                    if (previousRun > 0) bonus = Math.max(bonus, BONUS_CONSECUTIVE);
                    if (k === 0) bonus *= BONUS_FIRST_CHAR_MULTIPLIER;
                    best = inherited + SCORE_MATCH + bonus;
                    run = previousRun + 1;
                }
            }

            // …or skip this target character and keep looking for q[k] further right.
            if (i > k) {
                const left = scoreBuf[row + i - 1]!;
                const gap =
                    left + (runBuf[row + i - 1]! > 0 ? PENALTY_GAP_START : PENALTY_GAP_EXTRA);
                if (gap > best) {
                    best = gap;
                    run = 0;
                }
            }

            scoreBuf[row + i] = best;
            runBuf[row + i] = run;
        }
    }

    // Where did the best full match end?
    const lastRow = (m - 1) * n;
    let bestScore = NOT_MATCHED;
    let bestEnd = -1;
    for (let i = m - 1; i < n; i++) {
        if (runBuf[lastRow + i]! > 0 && scoreBuf[lastRow + i]! > bestScore) {
            bestScore = scoreBuf[lastRow + i]!;
            bestEnd = i;
        }
    }
    if (bestEnd < 0) return null;

    // Walk the run lengths back out to the matched cells.
    const foldedPositions: number[] = [];
    for (let k = m - 1, i = bestEnd; k >= 0 && i >= 0; i--) {
        if (runBuf[k * n + i]! > 0 && t[start + i] === q[k]) {
            foldedPositions.unshift(start + i);
            k--;
        }
    }

    // Length is deliberately NOT folded into the score — it is a tiebreaker in the comparator, so
    // that it can never outweigh a tier or a case bonus (see rank.ts).
    let score = bestScore + tierFor(q, t);
    for (let p = 0; p < foldedPositions.length; p++) {
        if (cased[foldedPositions[p]!] === foldedQuery.text[p]) score += CASE_BONUS;
    }

    // Fold indices → source indices, deduplicated (one source character can fold to several).
    const positions: number[] = [];
    for (const fi of foldedPositions) {
        const origin = foldedTarget.origin ? foldedTarget.origin[fi] : fi;
        if (origin !== undefined && positions[positions.length - 1] !== origin)
            positions.push(origin);
    }

    return { score, positions };
}

function charBonus(text: string, index: number): number {
    if (index === 0) return BONUS_BOUNDARY;
    const before = text[index - 1]!;
    if (SEPARATORS.has(before)) return BONUS_BOUNDARY;
    const current = text[index]!;
    if (before === before.toLowerCase() && current !== current.toLowerCase()) return BONUS_CAMEL;
    return 0;
}

function tierFor(query: string, target: string): number {
    if (target === query) return TIER_EXACT;
    if (target.startsWith(query)) return TIER_PREFIX;
    const words = target.split(WORD_SPLIT).filter(Boolean);
    for (const word of words) {
        if (word.startsWith(query)) return TIER_WORD_PREFIX;
    }
    let initials = "";
    for (const word of words) initials += word[0];
    return initials.startsWith(query) ? TIER_INITIALS : 0;
}

export interface HighlightSegment {
    text: string;
    hit: boolean;
}

/**
 * Splits `text` into alternating plain/matched segments for rendering. Positions are the code-unit
 * indices fuzzyMatch reported; each one covers one whole code point, so surrogate pairs survive.
 */
export function highlightSegments(text: string, positions: number[]): HighlightSegment[] {
    if (positions.length === 0) return text ? [{ text, hit: false }] : [];

    const marked = new Set(positions);
    const segments: HighlightSegment[] = [];
    let buffer = "";
    let bufferHit = false;
    let index = 0;

    for (const ch of text) {
        const hit = marked.has(index);
        if (buffer && hit !== bufferHit) {
            segments.push({ text: buffer, hit: bufferHit });
            buffer = "";
        }
        buffer += ch;
        bufferHit = hit;
        index += ch.length;
    }
    if (buffer) segments.push({ text: buffer, hit: bufferHit });
    return segments;
}
