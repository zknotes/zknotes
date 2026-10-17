<script lang="ts">
import type { Editor } from "@tiptap/core";
import { AlignLeft, AlignCenter, AlignRight, AlignJustify } from "lucide-svelte";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";
import Button from "$lib/core/ui/Button.svelte";

let {
    menus,
    editor,
    activeAlign,
}: {
    menus: PopoverMenus;
    editor: Editor | undefined;
    activeAlign: string;
} = $props();

function setAlign(align: string) {
    editor?.chain().focus().setTextAlign(align).run();
    menus.close("textAlign");
}
</script>

<ToolbarPopover open={menus.isOpen("textAlign")} anchor={menus.anchor("textAlign")} onclose={() => menus.close("textAlign")}>
    <div class="bg-[var(--surface-raised)] rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.7)] border border-[var(--stroke)] p-1 flex flex-col gap-0.5 w-32">
        <Button
            variant="ghost"
            active={activeAlign === "left"}
            class="w-full justify-start !px-2 !py-1.5 rounded"
            onclick={() => setAlign("left")}
        >
            <AlignLeft class="w-4 h-4 shrink-0" />
            <div class="flex flex-col items-start ml-2 text-sm leading-tight">
                <span>Left</span>
            </div>
        </Button>
        <Button
            variant="ghost"
            active={activeAlign === "center"}
            class="w-full justify-start !px-2 !py-1.5 rounded"
            onclick={() => setAlign("center")}
        >
            <AlignCenter class="w-4 h-4 shrink-0" />
            <div class="flex flex-col items-start ml-2 text-sm leading-tight">
                <span>Center</span>
            </div>
        </Button>
        <Button
            variant="ghost"
            active={activeAlign === "right"}
            class="w-full justify-start !px-2 !py-1.5 rounded"
            onclick={() => setAlign("right")}
        >
            <AlignRight class="w-4 h-4 shrink-0" />
            <div class="flex flex-col items-start ml-2 text-sm leading-tight">
                <span>Right</span>
            </div>
        </Button>
        <Button
            variant="ghost"
            active={activeAlign === "justify"}
            class="w-full justify-start !px-2 !py-1.5 rounded"
            onclick={() => setAlign("justify")}
        >
            <AlignJustify class="w-4 h-4 shrink-0" />
            <div class="flex flex-col items-start ml-2 text-sm leading-tight">
                <span>Justify</span>
            </div>
        </Button>
    </div>
</ToolbarPopover>
