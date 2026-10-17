<script lang="ts">
import type { Editor } from "@tiptap/core";
import { FONT_FAMILIES } from "$lib/core/constants/fonts";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ListPopover from "./ListPopover.svelte";

let {
    menus,
    editor,
    activeFormats,
}: {
    menus: PopoverMenus;
    editor: Editor | undefined;
    activeFormats: { fontFamily: string };
} = $props();

function select(value: string) {
    if (value) editor?.chain().focus().setFontFamily(value).run();
    else editor?.chain().focus().unsetFontFamily().run();
}
</script>

<ListPopover
    {menus}
    name="fontFamily"
    items={FONT_FAMILIES}
    isActive={(font) => activeFormats.fontFamily === font.value}
    onSelect={(font) => select(font.value)}
    width={180}
>
    {#snippet children(font, active)}
        <span class="text-sm" style={font.value ? `font-family: ${font.value}` : ""}>{font.label}</span>
    {/snippet}
</ListPopover>
