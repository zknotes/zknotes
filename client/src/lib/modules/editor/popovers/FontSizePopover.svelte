<script lang="ts">
// A small popup: − / size / + (not a long list). It stays open while you step.
// "Default" removes the textStyle fontSize mark. The toolbar trigger is the narrow number.
import type { Editor } from "@tiptap/core";
import { Minus, Plus } from "lucide-svelte";
import {
    FONT_SIZE_STEPS,
    fontSizeDisplayLabel,
    fontSizeStepIndex,
} from "$lib/core/constants/fonts";
import type { PopoverMenus } from "$lib/modules/editor/PopoverMenus.svelte";
import ToolbarPopover from "$lib/modules/editor/ToolbarPopover.svelte";
import Button from "$lib/core/ui/Button.svelte";

let {
    menus,
    editor,
    activeFormats,
}: {
    menus: PopoverMenus;
    editor: Editor | undefined;
    activeFormats: { fontSize: string };
} = $props();

const sizeLabel = $derived(fontSizeDisplayLabel(activeFormats.fontSize));
const stepIndex = $derived(fontSizeStepIndex(activeFormats.fontSize));
const canDecrease = $derived(stepIndex > 0);
const canIncrease = $derived(stepIndex < FONT_SIZE_STEPS.length - 1);
const isDefault = $derived(!activeFormats.fontSize);

function step(delta: number) {
    if (!editor) return;
    const next = stepIndex + delta;
    if (next < 0 || next >= FONT_SIZE_STEPS.length) return;
    const size = FONT_SIZE_STEPS[next];
    if (!size) return;
    editor.chain().focus().setFontSize(size.value).run();
}

function resetDefault() {
    if (!editor) return;
    editor.chain().focus().unsetFontSize().run();
}
</script>

<ToolbarPopover open={menus.isOpen("fontSize")} anchor={menus.anchor("fontSize")} onclose={() => menus.close("fontSize")}>
    <div
        class="bg-[var(--surface-raised)] rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.7)] border border-[var(--stroke)] p-1.5 flex flex-col gap-1 items-stretch"
    >
        <div class="inline-flex items-center justify-center gap-0.5">
            <Button
                variant="ghost"
                size="icon"
                class="!w-7 !h-7"
                disabled={!canDecrease}
                onmousedown={(e: MouseEvent) => e.preventDefault()}
                onclick={() => step(-1)}
                title="Decrease font size"
                aria-label="Decrease font size"
            >
                <Minus class="w-3.5 h-3.5" />
            </Button>
            <span
                class="min-w-[2rem] text-center text-sm font-medium tabular-nums text-[var(--text)] select-none"
                aria-live="polite"
            >
                {sizeLabel}
            </span>
            <Button
                variant="ghost"
                size="icon"
                class="!w-7 !h-7"
                disabled={!canIncrease}
                onmousedown={(e: MouseEvent) => e.preventDefault()}
                onclick={() => step(1)}
                title="Increase font size"
                aria-label="Increase font size"
            >
                <Plus class="w-3.5 h-3.5" />
            </Button>
        </div>
        <Button
            variant="ghost"
            active={isDefault}
            class="!h-6 !px-2 !py-0 text-2xs w-full"
            onmousedown={(e: MouseEvent) => e.preventDefault()}
            onclick={resetDefault}
            title="Reset to default size"
        >
            Default
        </Button>
    </div>
</ToolbarPopover>
