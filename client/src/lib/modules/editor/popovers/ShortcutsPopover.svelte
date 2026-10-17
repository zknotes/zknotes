<script lang="ts">
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";

let { menus }: { menus: PopoverMenus } = $props();
</script>

<ToolbarPopover open={menus.isOpen("shortcuts")} anchor={menus.anchor("shortcuts")} onclose={() => menus.close("shortcuts")}>
    <!-- w-max + rem padding: fixed px (w-[280px]) break under the app's UI zoom, because the root font-size grows while the box stays narrow. -->
    <div
        class="bg-[var(--surface-raised)] rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.7)] border border-[var(--stroke)] p-3 w-max text-[var(--text-sub)]"
    >
        <div class="text-xs font-mono font-bold text-[var(--text-dim)] uppercase tracking-wider mb-2">Shortcuts</div>
        <div class="space-y-2 text-xs">
            <div class="flex items-center justify-between gap-3 whitespace-nowrap"><span>Focus Editor / Nav</span> <span class="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-brand-fg font-mono text-2xs shrink-0">Alt + N</span></div>
            <div class="flex items-center justify-between gap-3 whitespace-nowrap"><span>Save Note</span> <span class="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-brand-fg font-mono text-2xs shrink-0">Ctrl + S</span></div>
            <div class="flex items-center justify-between gap-3 whitespace-nowrap"><span>Lock vault</span> <span class="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-brand-fg font-mono text-2xs shrink-0">Ctrl + Shift + Esc</span></div>
            <div class="flex items-center justify-between gap-3 whitespace-nowrap"><span>Rename Item</span> <span class="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-brand-fg font-mono text-2xs shrink-0">F2</span></div>
            <div class="flex items-center justify-between gap-3 whitespace-nowrap"><span>Delete Item</span> <span class="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-brand-fg font-mono text-2xs shrink-0">Delete</span></div>
            <div class="flex items-center justify-between gap-3 whitespace-nowrap"><span>Navigate Folders</span> <span class="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-brand-fg font-mono text-2xs shrink-0">↑ / ↓</span></div>
            <div class="flex items-center justify-between gap-3 whitespace-nowrap"><span>Open / Close</span> <span class="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-brand-fg font-mono text-2xs shrink-0">→ / ←</span></div>
            <div class="flex items-center justify-between gap-3 whitespace-nowrap"><span>Link to note</span> <span class="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-brand-fg font-mono text-2xs shrink-0">@</span></div>
            <div class="flex items-center justify-between gap-3 whitespace-nowrap"><span>Next / previous table cell</span> <span class="px-1.5 py-0.5 rounded bg-[var(--surface-raised)] text-brand-fg font-mono text-2xs shrink-0">Tab / Shift + Tab</span></div>
        </div>
    </div>
</ToolbarPopover>
