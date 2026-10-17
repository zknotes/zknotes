/**
 * The shared state behind the "search modal" pattern — the debounce, the results, the highlight index
 * and the ArrowUp/ArrowDown/Enter/Escape navigation. It used to be copy-pasted between
 * SearchDialog.svelte and NotePickerModal.svelte.
 */

export interface SearchListOptions<T> {
    /** Runs the search — called, debounced, on every input. */
    search: (query: string) => Promise<T[]>;
    debounceMs?: number;
    /**
     * The number of action rows BEFORE the results in the list (the "New note" row in SearchDialog,
     * say) — it counts towards the selection's range.
     */
    extraRows?: () => number;
    /** Enter on the currently selected index (including the extra rows). */
    onEnter: (sel: number) => void;
    onEscape?: () => void;
}

export interface SearchListState<T> {
    query: string;
    readonly results: T[];
    sel: number;
    /** Run the (debounced) search with the current query. */
    run(): void;
    onInput(): void;
    onKeydown(e: KeyboardEvent): void;
    /** Reset when the dialog opens. */
    reset(): void;
}

export function createSearchListState<T>(opts: SearchListOptions<T>): SearchListState<T> {
    const debounceMs = opts.debounceMs ?? 120;

    let query = $state("");
    let results = $state<T[]>([]);
    let sel = $state(0);
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    // Only the newest search may write the results — an earlier, slower one must not land on top of
    // it (the empty-query path answers immediately, so it can easily overtake a debounced one).
    let generation = 0;

    async function execute() {
        const mine = ++generation;
        let next: T[];
        try {
            next = await opts.search(query);
        } catch {
            next = [];
        }
        if (mine === generation) results = next;
    }

    /** Run the (debounced) search with the current query. */
    function run() {
        if (debounceTimer) clearTimeout(debounceTimer);
        // An empty query is answered locally by both callers (the recent items, the first notes in
        // the tree) — there is nothing to debounce, and the wait is visible when the dialog opens.
        if (!query.trim()) {
            void execute();
            return;
        }
        debounceTimer = setTimeout(() => void execute(), debounceMs);
    }

    function onInput() {
        sel = 0;
        run();
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            opts.onEscape?.();
            return;
        }
        const total = results.length + (opts.extraRows?.() ?? 0);
        if (e.key === "ArrowDown") {
            e.preventDefault();
            sel = Math.min(sel + 1, total - 1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            sel = Math.max(sel - 1, 0);
        } else if (e.key === "Enter") {
            e.preventDefault();
            opts.onEnter(sel);
        }
    }

    /** Reset when the dialog opens. */
    function reset() {
        if (debounceTimer) clearTimeout(debounceTimer);
        generation++; // drop whatever is still in flight from the previous open
        query = "";
        results = [];
        sel = 0;
    }

    return {
        get query() {
            return query;
        },
        set query(v: string) {
            query = v;
        },
        get results() {
            return results;
        },
        get sel() {
            return sel;
        },
        set sel(v: number) {
            sel = v;
        },
        run,
        onInput,
        onKeydown,
        reset,
    };
}
