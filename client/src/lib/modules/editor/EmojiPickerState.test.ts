// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMOJI_CATEGORIES } from "$lib/core/constants/emojis";
import { STORAGE_KEYS } from "$lib/core/utils/persisted";
import { EmojiPickerState } from "./EmojiPickerState.svelte";

beforeEach(() => {
    localStorage.clear();
});

describe("EmojiPickerState", () => {
    it("load() picks the first category tab when there are no recents", () => {
        const s = new EmojiPickerState();
        s.load();
        expect(s.recents).toEqual([]);
        expect(s.tab).toBe(EMOJI_CATEGORIES[0]?.label ?? "recent");
    });

    it("load() picks the recent tab when there are recents", () => {
        localStorage.setItem(STORAGE_KEYS.recentEmojis, JSON.stringify(["🔥", "✨"]));
        const s = new EmojiPickerState();
        s.load();
        expect(s.recents).toEqual(["🔥", "✨"]);
        expect(s.tab).toBe("recent");
    });

    it("insert() dedupes, trims to 24 and calls the editor", () => {
        const insertContent = vi.fn();
        const focus = vi.fn();
        const editor = {
            commands: { insertContent, focus },
        } as unknown as import("@tiptap/core").Editor;

        const s = new EmojiPickerState();
        s.recents = Array.from({ length: 24 }, (_, i) => `e${i}`);
        s.insert("🆕", editor);
        expect(insertContent).toHaveBeenCalledWith("🆕");
        expect(focus).toHaveBeenCalled();
        expect(s.recents[0]).toBe("🆕");
        expect(s.recents).toHaveLength(24);
        expect(s.recents).not.toContain("e23");

        s.insert("🆕", editor);
        expect(s.recents.filter((e) => e === "🆕")).toHaveLength(1);
        expect(s.recents[0]).toBe("🆕");
    });
});
