<script lang="ts">
import type { Editor } from "@tiptap/core";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import SwatchPopover from "./SwatchPopover.svelte";

let {
    menus,
    editor,
    activeColor,
}: { menus: PopoverMenus; editor: Editor | undefined; activeColor?: string } = $props();
</script>

<SwatchPopover
    {menus}
    name="color"
    {activeColor}
    onPick={(color) => editor?.chain().setColor(color).focus().run()}
    onReset={() => editor?.chain().focus().extendMarkRange("textStyle").unsetColor().run()}
/>
