<script lang="ts">
import type { Editor } from "@tiptap/core";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import MenuItem from "$lib/core/ui/MenuItem.svelte";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";
import { ensureCellSelection } from "$lib/modules/editor/table-commands";
import { TABLE_MENU_IDS, type MenuId } from "$lib/modules/editor/PopoverMenus.svelte";
import { tableMenuGroups } from "$lib/modules/editor/table-menu-model";
import type { TableUiController } from "$lib/modules/editor/TableUiController.svelte";

let {
    menus,
    editor,
    tableUi,
}: { menus: PopoverMenus; editor: Editor | undefined; tableUi: TableUiController } = $props();

let panel = $state<HTMLElement | undefined>();

const activeMenuId = $derived(TABLE_MENU_IDS.find((id) => menus.isOpen(id)));
const open = $derived(!!activeMenuId);

// The menu's target has to be VISIBLE before the user picks a command
$effect(() => {
    if (open && editor) ensureCellSelection(editor);
});

function cmd(fn: () => void) {
    fn();
    if (activeMenuId) menus.close(activeMenuId);
}

function align(dir: "left" | "center" | "right") {
    cmd(() => editor?.chain().focus(undefined, { scrollIntoView: false }).setTextAlign(dir).run());
}

function focusItem(delta: number) {
    const items = Array.from(
        panel?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (!items.length) return;
    const current = items.findIndex((el) => el === document.activeElement);
    const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : current + delta;
    items[((next % items.length) + items.length) % items.length]?.focus();
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
        e.preventDefault();
        focusItem(1);
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusItem(-1);
    }
}

const allGroups = $derived(tableMenuGroups(editor, tableUi));

// When a specific menu is open ("tableRow", say), show only that group.
// When the general "table" one is open, show them all.
const visibleGroups = $derived.by(() => {
    if (!activeMenuId) return [];
    if (activeMenuId === "table") return allGroups;
    const groupId = activeMenuId.replace("table", "").toLowerCase();
    return allGroups.filter((g) => g.id === groupId);
});
</script>

<ToolbarPopover {open} anchor={activeMenuId ? menus.anchor(activeMenuId) : undefined} onclose={() => activeMenuId && menus.close(activeMenuId)}>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		bind:this={panel}
		role="menu"
		tabindex="-1"
		aria-label="Table options"
		onkeydown={onKeydown}
		class="bg-[var(--surface-panel)] rounded-lg shadow-[var(--float-shadow)] border border-[var(--stroke)] p-1 w-[13.75rem] flex flex-col gap-0.5"
	>
        {#each visibleGroups as group, i (group.id)}
            {#if visibleGroups.length > 1}
                <div class="text-2xs font-mono uppercase tracking-wider text-[var(--text-dim)] px-2 pt-1 pb-0.5">{group.label}</div>
            {/if}
            
            {#each group.items as item}
                {#if item.kind === "align"}
                    <!-- Aligns the cell's CONTENT (TextAlign over the paragraphs in the selection) -->
                    <div class="flex items-center gap-2 px-2 py-1">
                        <span class="text-sm text-[var(--text-muted)] flex-1">Align content</span>
                        <div class="flex gap-0.5">
                            <Button variant="ghost" size="icon" class="w-6 h-6" title="Align left" aria-label="Align content left" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => align("left")}><AlignLeft class="w-3.5 h-3.5" /></Button>
                            <Button variant="ghost" size="icon" class="w-6 h-6" title="Align center" aria-label="Align content center" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => align("center")}><AlignCenter class="w-3.5 h-3.5" /></Button>
                            <Button variant="ghost" size="icon" class="w-6 h-6" title="Align right" aria-label="Align content right" onmousedown={(e: MouseEvent) => e.preventDefault()} onclick={() => align("right")}><AlignRight class="w-3.5 h-3.5" /></Button>
                        </div>
                    </div>
                {:else}
                    <MenuItem icon={item.icon} label={item.label} disabled={item.disabled} danger={item.danger} onclick={() => cmd(item.action)} />
                {/if}
            {/each}

            {#if i < visibleGroups.length - 1}
                <div class="h-px bg-[var(--stroke)] my-1"></div>
            {/if}
        {/each}
	</div>
</ToolbarPopover>
