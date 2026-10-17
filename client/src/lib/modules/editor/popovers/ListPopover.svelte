<script lang="ts" generics="T">
import { Check } from "lucide-svelte";
import type { PopoverMenus, MenuId } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";
import type { Snippet } from "svelte";
import Button from "$lib/core/ui/Button.svelte";

let {
    menus,
    name,
    items,
    isActive,
    onSelect,
    children,
    width = 180,
    maxHeight,
    header,
}: {
    menus: PopoverMenus;
    name: MenuId;
    items: T[];
    isActive: (item: T) => boolean;
    onSelect: (item: T) => void;
    children: Snippet<[T, boolean]>;
    /** Design px @ a 16px root — converted into rem so it follows the app's UI zoom. */
    width?: number;
    /** Design px @ a 16px root — converted into rem (the same reason as width). */
    maxHeight?: number;
    header?: Snippet;
} = $props();

// Fixed px break under the app zoom (the root font-size %): rem text grows while the panel stays narrow.
const widthRem = $derived(width / 16);
const maxHeightRem = $derived(maxHeight != null ? maxHeight / 16 : null);
</script>

<ToolbarPopover open={menus.isOpen(name)} anchor={menus.anchor(name)} onclose={() => menus.close(name)}>
    <div
        class="bg-[var(--surface-raised)] rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.7)] border border-[var(--stroke)] p-1 flex flex-col gap-0.5 w-max"
        style="min-width: {widthRem}rem;{maxHeightRem != null
            ? ` max-height: ${maxHeightRem}rem; overflow-y: auto;`
            : ''}"
    >
        {#if header}{@render header()}{/if}
        {#each items as item}
            {@const active = isActive(item)}
            <Button
                variant="ghost"
                active={active}
                class="w-full justify-between !px-2 !py-1.5 rounded whitespace-nowrap"
                onclick={() => { onSelect(item); menus.close(name); }}
            >
                <div class="flex items-center gap-2 min-w-0">
                    {@render children(item, active)}
                </div>
                {#if active}<Check class="w-3.5 h-3.5 shrink-0" />{/if}
            </Button>
        {/each}
    </div>
</ToolbarPopover>
