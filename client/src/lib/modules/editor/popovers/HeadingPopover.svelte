<script lang="ts">
import type { Editor } from "@tiptap/core";
import { Pilcrow } from "lucide-svelte";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ListPopover from "./ListPopover.svelte";
import Button from "$lib/core/ui/Button.svelte";

let {
    menus,
    editor,
    activeFormats,
}: {
    menus: PopoverMenus;
    editor: Editor | undefined;
    activeFormats: { h1: boolean; h2: boolean; h3: boolean; h4: boolean };
} = $props();

const LEVELS = [1, 2, 3, 4] as const;

function setParagraph() {
    editor?.chain().focus().setParagraph().run();
    menus.close("heading");
}

function setHeading(level: (typeof LEVELS)[number]) {
    editor?.chain().focus().toggleHeading({ level }).run();
}

const isHeading = $derived(
    activeFormats.h1 || activeFormats.h2 || activeFormats.h3 || activeFormats.h4,
);
</script>

<ListPopover
    {menus}
    name="heading"
    items={[1, 2, 3, 4]}
    isActive={(level) => activeFormats[`h${level}` as "h1" | "h2" | "h3" | "h4"]}
    onSelect={(level) => setHeading(level as 1|2|3|4)}
    width={220}
>
    {#snippet header()}
        <Button
            variant="ghost"
            active={!isHeading}
            class="w-full justify-start !px-2 !py-1.5 rounded mb-0.5 whitespace-nowrap"
            onclick={setParagraph}
        >
            <Pilcrow class="w-3.5 h-3.5 shrink-0" />
            <span class="text-sm">Normal text</span>
        </Button>
    {/snippet}
    {#snippet children(level, active)}
        <span class="font-bold text-xs w-5 shrink-0">H{level}</span>
        <span class="font-bold whitespace-nowrap" style="font-size: {[1.125, 1, 0.875, 0.8125][level - 1]}rem;">Heading {level}</span>
    {/snippet}
</ListPopover>
