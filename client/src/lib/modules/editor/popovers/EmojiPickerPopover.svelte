<script lang="ts">
import type { Editor } from "@tiptap/core";
import { EMOJI_CATEGORIES } from "$lib/core/constants/emojis";
import type { EmojiPickerState } from "$lib/modules/editor/EmojiPickerState.svelte";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";
import { EmptyState } from "$lib/core/ui";

let {
    menus,
    emojiState,
    editor,
}: {
    menus: PopoverMenus;
    emojiState: EmojiPickerState;
    editor: Editor | undefined;
} = $props();
</script>

<!-- UX refactor: exempt-editor-popover — keep raw buttons (refactor_ux_audit.md) -->
<ToolbarPopover open={menus.isOpen("emoji")} anchor={menus.anchor("emoji")} onclose={() => menus.close("emoji")}>
    <div
        class="bg-[var(--surface-raised)] text-[var(--text)] rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.7)] border border-[var(--stroke)] flex flex-col"
        style="width: 300px; max-height: 340px;"
    >
        <div class="flex items-center gap-0.5 px-2 pt-2 pb-1 border-b border-[var(--stroke)] overflow-x-auto shrink-0" style="scrollbar-width:none">
            <button
                onclick={() => emojiState.tab = 'recent'}
                class="w-8 h-8 rounded-lg flex items-center justify-center text-base flex-shrink-0 transition {emojiState.tab === 'recent' ? 'bg-[var(--surface-raised)] text-[var(--text)]' : 'text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text-sub)]'}"
                title="Recently used"
            >🕐</button>
            {#each EMOJI_CATEGORIES as cat}
                <button
                    onclick={() => emojiState.tab = cat.label}
                    class="w-8 h-8 rounded-lg flex items-center justify-center text-base flex-shrink-0 transition {emojiState.tab === cat.label ? 'bg-[var(--surface-raised)] text-[var(--text)]' : 'text-[var(--text-dim)] hover:bg-[var(--row-hover)] hover:text-[var(--text-sub)]'}"
                    title={cat.label}
                >{cat.icon}</button>
            {/each}
        </div>

        <div class="flex-1 overflow-y-auto p-2 min-h-0">
            {#if emojiState.tab === 'recent'}
                {#if emojiState.recents.length === 0}
                    <EmptyState class="flex items-center justify-center h-20 font-mono">No recently used emojis yet</EmptyState>
                {:else}
                    <div class="flex flex-wrap gap-0.5">
                        {#each emojiState.recents as em}
                            <button class="w-8 h-8 rounded-lg hover:bg-[var(--row-hover)] transition-colors flex items-center justify-center text-lg leading-none" onclick={() => { emojiState.insert(em, editor); menus.close("emoji"); }} title={em}>{em}</button>
                        {/each}
                    </div>
                {/if}
            {:else}
                {#each EMOJI_CATEGORIES.filter(c => c.label === emojiState.tab) as cat}
                    <div class="flex flex-wrap gap-0.5">
                        {#each cat.emojis as em}
                            <button class="w-8 h-8 rounded-lg hover:bg-[var(--row-hover)] transition-colors flex items-center justify-center text-lg leading-none" onclick={() => { emojiState.insert(em, editor); menus.close("emoji"); }} title={em}>{em}</button>
                        {/each}
                    </div>
                {/each}
            {/if}
        </div>
    </div>
</ToolbarPopover>
