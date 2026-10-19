import { describe, expect, it, vi } from "vitest";
import { createSearchListState } from "./search-list-state.svelte";

// Saas spec 156 (package G): the shared "search modal" state — keyboard clamps and the generation
// guard that keeps a slower, earlier search from overwriting a newer answer.
const key = (k: string) => ({ key: k, preventDefault: vi.fn() }) as unknown as KeyboardEvent;

describe("createSearchListState", () => {
    it("clamps the highlight to the rows, extra rows included, and Enter reports it", async () => {
        const onEnter = vi.fn();
        const state = createSearchListState<string>({
            search: async () => ["one", "two"],
            extraRows: () => 1,
            onEnter,
        });
        state.run(); // empty query answers at once
        await vi.waitFor(() => expect(state.results).toEqual(["one", "two"]));

        state.onKeydown(key("ArrowDown"));
        state.onKeydown(key("ArrowDown"));
        state.onKeydown(key("ArrowDown"));
        expect(state.sel).toBe(2);
        state.onKeydown(key("ArrowUp"));
        state.onKeydown(key("ArrowUp"));
        state.onKeydown(key("ArrowUp"));
        expect(state.sel).toBe(0);
        state.onKeydown(key("Enter"));
        expect(onEnter).toHaveBeenCalledWith(0);
    });

    it("a slower earlier search never overwrites a later answer", async () => {
        let resolveSlow: ((v: string[]) => void) | undefined;
        const search = vi
            .fn<(q: string) => Promise<string[]>>()
            .mockImplementationOnce(() => new Promise((r) => (resolveSlow = r)))
            .mockImplementationOnce(async () => ["fast"]);
        const state = createSearchListState<string>({ search, debounceMs: 0, onEnter: () => {} });
        state.run(); // slow one (empty query, immediate dispatch)
        state.run(); // fast one
        await vi.waitFor(() => expect(state.results).toEqual(["fast"]));
        resolveSlow?.(["slow"]);
        await new Promise((r) => setTimeout(r, 5));
        expect(state.results).toEqual(["fast"]);
    });

    it("reset drops whatever is still in flight", async () => {
        let resolveLate: ((v: string[]) => void) | undefined;
        const state = createSearchListState<string>({
            search: () => new Promise((r) => (resolveLate = r)),
            onEnter: () => {},
        });
        state.run();
        state.reset();
        resolveLate?.(["late"]);
        await new Promise((r) => setTimeout(r, 5));
        expect(state.results).toEqual([]);
        expect(state.query).toBe("");
    });
});
