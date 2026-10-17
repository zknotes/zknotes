<script lang="ts">
// A standalone level picker (for use outside the app menu). The same freeze session as
// SidebarAppMenu: the size is frozen on open and counter-scaled until it closes.
import { Check, ZoomIn } from "lucide-svelte";
import Button from "./Button.svelte";
import { uiZoomStore } from "$lib/core/stores/ui-zoom.svelte";
import { UI_ZOOM_LEVELS } from "$lib/core/constants/ui-zoom-levels";

let open = $state(false);
let wrapEl = $state<HTMLDivElement | null>(null);
let frozenFactor = $state<number | null>(null);
let pin = $state<{ left: number; bottom: number } | null>(null);

const currentFactor = $derived.by(() => {
    const _level = uiZoomStore.current;
    void _level;
    return uiZoomStore.factor;
});

const menuScale = $derived(
    frozenFactor != null && currentFactor > 0 ? frozenFactor / currentFactor : 1,
);

function close() {
    open = false;
    frozenFactor = null;
    pin = null;
}

function toggle() {
    if (open) {
        close();
        return;
    }
    frozenFactor = uiZoomStore.factor;
    const rect = wrapEl?.getBoundingClientRect();
    if (rect) {
        const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const gap = 0.5 * rootPx;
        pin = {
            left: rect.left,
            bottom: window.innerHeight - rect.top + gap,
        };
    } else {
        pin = null;
    }
    open = true;
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
}

function pick(id: (typeof UI_ZOOM_LEVELS)[number]["id"]) {
    uiZoomStore.set(id);
    close();
}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="relative" bind:this={wrapEl}>
    <Button
        variant="ghost"
        size="icon"
        onclick={toggle}
        class="!w-[24px] !h-[24px]"
        title="UI zoom"
        aria-expanded={open}
    >
        <ZoomIn class="w-[12px] h-[12px]" />
    </Button>

    {#if open}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fixed inset-0 z-40" onclick={close} onkeydown={() => {}}></div>

        <div
            class="ctx-menu z-50 min-w-[140px]"
            class:fixed={!!pin}
            class:absolute={!pin}
            class:bottom-full={!pin}
            class:mb-2={!pin}
            class:left-0={!pin}
            style={pin
                ? `left: ${pin.left}px; bottom: ${pin.bottom}px; transform: scale(${menuScale}); transform-origin: bottom left;`
                : undefined}
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
