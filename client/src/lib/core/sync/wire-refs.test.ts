import { describe, expect, it } from "vitest";
import type { LocalItem } from "$lib/core/db";
import { hasLocalChunkSetRef } from "./wire";

// Saas spec 156 (package G): whether another live row still shares a chunk set decides whether the
// chunks may be evicted — a false negative deletes a file another item needs.
const row = (id: string, chunk_set_id: string | null, purged_at: number | null = null) =>
    ({ id, chunk_set_id, purged_at, type: "file" }) as unknown as LocalItem;

describe("hasLocalChunkSetRef", () => {
    it("ignores the item itself and purged rows, counts any other live reference", () => {
        const items = [row("a", "cs1"), row("b", "cs1"), row("c", "cs1", 123), row("d", "cs2")];
        expect(hasLocalChunkSetRef(items, "cs1", "a")).toBe(true);
        expect(hasLocalChunkSetRef([row("a", "cs1"), row("c", "cs1", 123)], "cs1", "a")).toBe(
            false,
        );
        expect(hasLocalChunkSetRef(items, "cs2", "d")).toBe(false);
        expect(hasLocalChunkSetRef(items, "cs3", "a")).toBe(false);
    });
});
