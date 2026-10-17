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
    name="highlight"
    {activeColor}
    onPick={(color) => editor?.chain().setHighlight({ color }).focus().run()}
    onReset={() => editor?.chain().focus().extendMarkRange("highlight").unsetHighlight().run()}
/>
