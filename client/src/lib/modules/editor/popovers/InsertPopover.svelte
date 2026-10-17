<script lang="ts">
import { FileCode, Import } from "lucide-svelte";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";
import Button from "$lib/core/ui/Button.svelte";

let {
    menus,
    onInsertMarkdown,
}: {
    menus: PopoverMenus;
    onInsertMarkdown: () => void;
} = $props();
</script>

<ToolbarPopover open={menus.isOpen("insert")} anchor={menus.anchor("insert")} onclose={() => menus.close("insert")}>
    <div class="bg-[var(--surface-raised)] rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.7)] border border-[var(--stroke)] p-1 flex flex-col gap-0.5 w-40">
        <Button
            variant="ghost"
            class="w-full justify-start !px-2 !py-1.5 rounded"
            onclick={() => { onInsertMarkdown(); menus.close("insert"); }}
        >
            <FileCode class="w-4 h-4 shrink-0 text-[var(--accent-color)]" />
            <div class="flex flex-col items-start ml-2 text-sm leading-tight">
                <span>Markdown</span>
            </div>
        </Button>
    </div>
</ToolbarPopover>
