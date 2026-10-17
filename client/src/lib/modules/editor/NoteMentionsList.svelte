<script lang="ts">
import { FileText } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import { EmptyState, ItemTitle } from "$lib/core/ui";

let { items = [], command } = $props<{
    items: Array<{ id: string; title: string; icon?: string; color?: string }>;
    command: (item: { id: string; label: string }) => void;
}>();

let selectedIndex = $state(0);

// The keydown handler the Tippy/Tiptap suggestions config calls
export function onKeyDown({ event }: { event: KeyboardEvent }): boolean {
    // An empty list: do not swallow the keys. Otherwise an Enter after "@nosuchnote" would not insert
    // a new line, and the arrows would divide by 0 (selectedIndex → NaN).
    if (items.length === 0) return false;

    if (event.key === "ArrowUp") {
        upHandler();
        return true;
    }

    if (event.key === "ArrowDown") {
        downHandler();
        return true;
    }

    if (event.key === "Enter") {
        enterHandler();
        return true;
    }

    return false;
}

function upHandler() {
    selectedIndex = (selectedIndex + items.length - 1) % items.length;
}

function downHandler() {
    selectedIndex = (selectedIndex + 1) % items.length;
}

function enterHandler() {
    selectItem(selectedIndex);
}

function selectItem(index: number) {
    const item = items[index];
    if (item) {
        command({ id: item.id, label: item.title });
    }
}

// Reset the selected index when the items change
$effect(() => {
    if (items) {
        selectedIndex = 0;
    }
});
</script>

<div class="z-[100] bg-[var(--surface-panel)] border border-[var(--stroke)] rounded-lg shadow-xl py-1 overflow-hidden min-w-[220px] max-w-[320px] flex flex-col gap-px">
    {#if items.length > 0}
        {#each items as item, index}
            <Button
                variant="ghost"
                active={selectedIndex === index}
                class="w-full !justify-start gap-2 px-3 py-1.5 text-sm select-none"
                onclick={() => selectItem(index)}
            >
                <span class="flex-shrink-0 flex items-center justify-center w-4 h-4 text-[var(--text-dim)]">
                    {#if item.icon}
                        <span class="emoji-icon text-xs">{item.icon}</span>
                    {:else}
                        <FileText class="w-3.5 h-3.5" />
                    {/if}
                </span>
                <ItemTitle
                    class="flex-1 min-w-0 !font-normal"
                    style={item.color ? `color: ${item.color}` : ""}
                >
                    {item.title}
                </ItemTitle>
            </Button>
        {/each}
    {:else}
        <EmptyState class="px-3 py-2 italic text-left">No notes found</EmptyState>
    {/if}
</div>
