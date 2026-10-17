import { describe, expect, it } from "vitest";
import { ItemKeyCache } from "./item-key-cache";

function key(n: number): Uint8Array {
    return new Uint8Array([n % 256]);
}

// A regression: cacheItemKey was a private function inside crypto.worker.ts, untestable without a
// worker context. Lifted into this module so the LRU logic is directly testable, with no change in
// behaviour from the outside (the worker is still the only thing that instantiates it).
describe("ItemKeyCache", () => {
    it("re-adding an existing item key refreshes its eviction position", () => {
        const cache = new ItemKeyCache(500);
        for (let i = 0; i < 500; i++) cache.set(`item-${i}`, key(i));
        expect(cache.size).toBe(500);

        // Re-add the FIRST key — it has to become the freshest (an LRU "use"), not stay the oldest.
        cache.set("item-0", key(0));

        // Add one more past the cap — it has to evict what is NOW the oldest (item-1), not item-0.
        cache.set("item-500", key(500));

        expect(cache.has("item-0")).toBe(true);
        expect(cache.has("item-1")).toBe(false);
        expect(cache.has("item-500")).toBe(true);
        expect(cache.size).toBe(500);
    });

    it("evicts the least-recently-used key when over capacity", () => {
        const cache = new ItemKeyCache(2);
        cache.set("a", key(1));
        cache.set("b", key(2));
        cache.set("c", key(3)); // over the cap → evict "a" (the oldest)

        expect(cache.has("a")).toBe(false);
        expect(cache.has("b")).toBe(true);
        expect(cache.has("c")).toBe(true);
        expect(cache.size).toBe(2);
    });

    it("get() refreshes LRU position", () => {
        const cache = new ItemKeyCache(2);
        cache.set("a", key(1));
        cache.set("b", key(2));
        // Touch "a" — it becomes the freshest; the eviction has to take "b".
        expect(cache.get("a")).toEqual(key(1));
        cache.set("c", key(3));
        expect(cache.has("a")).toBe(true);
        expect(cache.has("b")).toBe(false);
        expect(cache.has("c")).toBe(true);
    });

    it("zeroizes the previous buffer when set() replaces a key with a different reference", () => {
        const cache = new ItemKeyCache(2);
        const first = new Uint8Array([1, 2, 3]);
        cache.set("a", first);
        const second = new Uint8Array([4, 5, 6]);
        cache.set("a", second);
        expect(Array.from(first)).toEqual([0, 0, 0]);
        expect(Array.from(cache.get("a") ?? [])).toEqual([4, 5, 6]);
    });

    it("does not zeroize when set() refreshes the same buffer reference", () => {
        const cache = new ItemKeyCache(2);
        const same = new Uint8Array([7, 8, 9]);
        cache.set("a", same);
        cache.set("a", same);
        expect(Array.from(same)).toEqual([7, 8, 9]);
        expect(cache.get("a")).toBe(same);
    });

    it("zeroizes evicted and cleared keys", () => {
        const cache = new ItemKeyCache(1);
        const k1 = key(1);
        cache.set("a", k1);
        cache.set("b", key(2)); // evict "a" → k1 has to be zeroized
        expect(Array.from(k1)).toEqual([0]);

        const k2 = new Uint8Array([9, 9]);
        cache.set("c", k2);
        cache.clear();
        expect(Array.from(k2)).toEqual([0, 0]);
        expect(cache.size).toBe(0);
    });
});
