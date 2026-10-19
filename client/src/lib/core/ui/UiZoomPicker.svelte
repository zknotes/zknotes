<script lang="ts">
// A standalone level picker (for use outside the app menu). The same freeze session as
// SidebarAppMenu (`FrozenPopover`): the size is frozen on open and counter-scaled until it closes.
import { Check, ZoomIn } from "lucide-svelte";
import Button from "./Button.svelte";
import { uiZoomStore } from "$lib/core/stores/ui-zoom.svelte";
import { UI_ZOOM_LEVELS } from "$lib/core/constants/ui-zoom-levels";
import { FrozenPopover } from "./frozen-popover.svelte";

let wrapEl = $state<HTMLDivElement | null>(null);
const popover = new FrozenPopover();

function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") popover.close();
}

function pick(id: (typeof UI_ZOOM_LEVELS)[number]["id"]) {
    uiZoomStore.set(id);
    popover.close();
}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="relative" bind:this={wrapEl}>
    <Button
        variant="ghost"
        size="icon"
        onclick={() => popover.toggle(wrapEl)}
        class="!w-[24px] !h-[24px]"
        title="UI zoom"
        aria-expanded={popover.open}
    >
        <ZoomIn class="w-[12px] h-[12px]" />
    </Button>

    {#if popover.open}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fixed inset-0 z-40" onclick={popover.close} onkeydown={() => {}}></div>

        <div
            class="ctx-menu z-50 min-w-[140px]"
            class:fixed={!!popover.pin}
            class:absolute={!popover.pin}
            class:bottom-full={!popover.pin}
            class:mb-2={!popover.pin}
            class:left-0={!popover.pin}
            style={popover.style}
        >
            {#each UI_ZOOM_LEVELS as l}
                <!-- UX refactor: ctx-item stays raw (context menu pattern) -->
                <button class="ctx-item w-full text-2xs" onclick={() => pick(l.id)}>
                    <span class="flex-1 text-left">{l.label}</span>
                    {#if uiZoomStore.current === l.id}
                        <Check class="w-3 h-3" style="color: var(--accent-color)" />
                    {/if}
                </button>
            {/each}
        </div>
    {/if}
</div>
