<script lang="ts">
import type { Editor } from "@tiptap/core";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";

let { menus, editor }: { menus: PopoverMenus; editor: Editor | undefined } = $props();

let hover = $state({ rows: 0, cols: 0 });
const SIZE = Array.from({ length: 8 }, (_, i) => i);
const CELL = 18;
const GAP = 3;
const COLS = 8;
// A fixed grid width — 1fr with no explicit container width lays the popup out wrongly.
const GRID_W = COLS * CELL + (COLS - 1) * GAP;
</script>

<ToolbarPopover open={menus.isOpen("tablePicker")} anchor={menus.anchor("tablePicker")} onclose={() => menus.close("tablePicker")}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="bg-[var(--surface-panel)] rounded-lg shadow-[var(--float-shadow)] border border-[var(--stroke)] overflow-hidden"
        style="padding: 10px; width: {GRID_W + 20}px"
        onmouseleave={() => { hover = { rows: 0, cols: 0 }; }}
    >
        <div class="text-2xs font-mono text-[var(--text-dim)] text-center mb-2 h-4">
            {hover.rows > 0 ? `${hover.rows} × ${hover.cols}` : 'Insert Table'}
        </div>
        <div
            data-testid="table-picker-grid"
            style="display: grid; grid-template-columns: repeat({COLS}, {CELL}px); gap: {GAP}px;"
        >
            {#each SIZE as r}
                {#each SIZE as c}
                    {@const selected = r < hover.rows && c < hover.cols}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                        style="width: {CELL}px; height: {CELL}px;"
                        class="rounded-[2px] border cursor-pointer transition-colors shrink-0 {selected ? 'bg-brand0/30 border-brand0/60' : 'bg-[var(--surface-raised)] border-[color-mix(in_srgb,var(--text-dim)_50%,var(--stroke))] hover:border-[var(--text-muted)] hover:bg-[var(--row-hover)]'}"
                        onmouseenter={() => { hover = { rows: r + 1, cols: c + 1 }; }}
                        onclick={() => {
                            // No header row: `th` is shaded (app.css `.ProseMirror th`), so every new
                            // table would look as though it already had a title row. The header is
                            // switched on from Row ▾ → "Toggle header row".
                            editor?.chain().focus().insertTable({ rows: r + 1, cols: c + 1, withHeaderRow: false }).run();
                            menus.close("tablePicker");
                            hover = { rows: 0, cols: 0 };
                        }}
                    ></div>
                {/each}
            {/each}
        </div>
    </div>
</ToolbarPopover>
