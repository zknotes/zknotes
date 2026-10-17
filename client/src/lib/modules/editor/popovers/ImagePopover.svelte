<script lang="ts">
import type { Editor } from "@tiptap/core";
import { ImageIcon, Upload } from "lucide-svelte";
import type { Attachment } from "svelte/attachments";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";
import { handleEditorImageFiles } from "$lib/modules/files/editor-images";
import Button from "$lib/core/ui/Button.svelte";

let {
    menus,
    editor,
    currentNoteId,
}: {
    menus: PopoverMenus;
    editor: Editor | undefined;
    currentNoteId: string | undefined;
} = $props();

const open = $derived(menus.isOpen("image"));

let fileEl: HTMLInputElement | undefined = $state();

// ToolbarPopover mounts its content only while it is open, so this runs once per open. The
// microtask waits until the popover is positioned and visible: a hidden element cannot take focus.
const focusOnOpen: Attachment<HTMLElement> = (el) => {
    queueMicrotask(() => el.focus());
};

function onFileChange() {
    if (!fileEl || !editor || !currentNoteId) return;
    const files = Array.from(fileEl.files ?? []);
    fileEl.value = "";
    if (files.length > 0) void handleEditorImageFiles(editor, files, currentNoteId, null);
    menus.close("image");
}
</script>

<ToolbarPopover {open} anchor={menus.anchor("image")} onclose={() => menus.close("image")}>
    <div
        class="bg-[var(--surface-raised)] rounded-lg shadow-[0_12px_32px_rgba(0,0,0,0.7)] border border-[var(--stroke)] p-3 w-[260px] flex flex-col gap-2.5"
    >
        <div class="flex flex-col gap-1">
            <div class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                <ImageIcon class="w-3.5 h-3.5" /> Insert image
            </div>
            <p class="text-2xs text-[var(--text-dim)]">
                Pick an image from this device. It is encrypted and stored with the note.
            </p>
        </div>

        <Button
            type="button"
            variant="ghost"
            onclick={() => fileEl?.click()}
            class="w-full border-dashed"
            {@attach focusOnOpen}
        >
            <Upload class="w-4 h-4" /> Upload from device
        </Button>

        <input
            type="file"
            accept="image/*"
            multiple
            bind:this={fileEl}
            onchange={onFileChange}
            class="hidden"
        />
    </div>
</ToolbarPopover>
