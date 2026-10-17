import type { Editor } from "@tiptap/core";
import { EMOJI_CATEGORIES } from "$lib/core/constants/emojis";
import { loadPersisted, STORAGE_KEYS, savePersisted } from "$lib/core/utils/persisted";

export class EmojiPickerState {
    tab = $state("recent");
    recents = $state<string[]>([]);

    // Load from localStorage and set the initial tab — call this before the picker opens.
    load(): void {
        this.recents = loadPersisted<string[]>(STORAGE_KEYS.recentEmojis, this.recents);
        this.tab = this.recents.length ? "recent" : (EMOJI_CATEGORIES[0]?.label ?? "recent");
    }

    insert(emoji: string, editor: Editor | undefined): void {
        editor?.commands.insertContent(emoji);
        editor?.commands.focus();
        const next = [emoji, ...this.recents.filter((e) => e !== emoji)].slice(0, 24);
        this.recents = next;
        savePersisted(STORAGE_KEYS.recentEmojis, next);
    }
}
