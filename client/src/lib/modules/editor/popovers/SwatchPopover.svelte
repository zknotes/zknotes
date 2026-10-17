<script lang="ts">
import type { PopoverMenus, MenuId } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";
import { COLOR_GRID } from "$lib/core/constants/colors";
import Button from "$lib/core/ui/Button.svelte";

const MAX_RECENT = 5;

let {
    menus,
    name,
    activeColor,
    onPick,
    onReset,
}: {
    menus: PopoverMenus;
    name: MenuId;
    activeColor?: string;
    onPick: (color: string) => void;
    onReset: () => void;
} = $props();

const storageKey = $derived(`recentColors:${name}`);

function loadRecent(): string[] {
    try {
        return JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    } catch {
        return [];
    }
}

let recentColors = $state<string[]>(loadRecent());

function pick(color: string) {
    const recent = recentColors.filter((c) => c !== color);
    recent.unshift(color);
    recentColors = recent.slice(0, MAX_RECENT);
    localStorage.setItem(storageKey, JSON.stringify(recentColors));
    onPick(color);
    menus.close(name);
}

function swatchClass(color: string): string {
    const isActive = activeColor !== undefined && color === activeColor;
    return isActive
        ? "cursor-pointer hover:scale-110 transition-transform ring-2 ring-white ring-offset-1 ring-offset-[var(--surface-raised)]"
        : "cursor-pointer hover:scale-110 transition-transform border border-[var(--stroke)]";
}
</script>

<ToolbarPopover open={menus.isOpen(name)} anchor={menus.anchor(name)} onclose={() => menus.close(name)}>
    <div
        class="bg-[var(--surface-raised)] rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.7)] border border-[var(--stroke)] overflow-hidden"
        style="padding: 8px; width: 160px"
    >
        <!-- UX refactor: exempt-editor-popover — 16×16 swatch grid stays raw (refactor_ux_audit.md) -->
        {#if recentColors.length > 0}
            <div style="margin-bottom: 6px">
                <p class="uppercase text-[var(--text-dim)] text-2xs" style="letter-spacing: 0.1em; margin-bottom: 4px">Recent</p>
                <div style="display: flex; gap: 2px">
                    {#each recentColors as color}
                        <button
                            class={swatchClass(color)}
                            style="width: 16px; height: 16px; border-radius: 3px; background-color: {color}; flex-shrink: 0"
                            onclick={() => pick(color)}
                            title={color}
                        ></button>
                    {/each}
                </div>
            </div>
            <div class="border-t border-[var(--stroke)]" style="margin-bottom: 6px"></div>
        {/if}
        <div style="display: grid; grid-template-columns: repeat(8, 16px); gap: 2px">
            {#each COLOR_GRID as color}
                <button
                    class={swatchClass(color)}
                    style="width: 16px; height: 16px; border-radius: 3px; background-color: {color}"
                    onclick={() => pick(color)}
                    title={color}
                ></button>
            {/each}
        </div>
        <Button
            variant="ghost"
            class="w-full mt-2 !py-1 !text-2xs border border-[var(--stroke)] font-mono uppercase tracking-wider text-[var(--text-dim)] hover:text-[var(--text)]"
            onclick={() => { onReset(); menus.close(name); }}
        >Reset</Button>
    </div>
</ToolbarPopover>
