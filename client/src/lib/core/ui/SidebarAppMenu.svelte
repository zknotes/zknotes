<script lang="ts">
// The app-level menu: Settings / Zoom / Help. Its scope is the whole app, which is why it sits on the
// left in the sidebar footer. A self-contained trigger+popover, the same pattern as
// ThemePicker/UiZoomPicker. The theme stays in Settings → Appearance alone — it is not here, because
// the app has no submenu pattern and a row of chips proved unreadable.
//
// Zoom freeze: while the menu is open, its size and viewport position are frozen at their state at
// the moment it opened. The app zoom still changes the rest of the UI at once; the menu counter-scales
// (a transform) and stays fixed, so + and − do not jump out from under the cursor. On close the
// freeze goes away; the next open takes the new, larger or smaller, size.
import { ChevronUp, HelpCircle, Minus, Plus, Settings, ZoomIn } from "lucide-svelte";
import { afterNavigate } from "$app/navigation";
import Button from "./Button.svelte";
import { uiZoomStore } from "$lib/core/stores/ui-zoom.svelte";
import { settingsLastTabStore } from "$lib/core/stores/settings-last-tab.svelte";
import { UI_ZOOM_LEVELS } from "$lib/core/constants/ui-zoom-levels";

let open = $state(false);
let triggerEl = $state<HTMLButtonElement | null>(null);

// The freeze session while the menu is open (null = closed / no freeze).
let frozenFactor = $state<number | null>(null);
let pin = $state<{ left: number; bottom: number } | null>(null);

const zoomIndex = $derived(UI_ZOOM_LEVELS.findIndex((l) => l.id === uiZoomStore.current));

// The reactive current scale — reading .current so the $derived follows the store.
const currentFactor = $derived.by(() => {
    const _level = uiZoomStore.current;
    void _level;
    return uiZoomStore.factor;
});

// 1 at open; when the user steps the zoom, the layout (in rem) grows or shrinks → the scale returns the visuals to the frozen state.
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
    // Freeze the size and anchor the menu in viewport pixels — absolute positioning plus a parent
    // reflow (the sidebar grows with the zoom) would otherwise move the whole popover even though the
    // counter-scale holds the font.
    frozenFactor = uiZoomStore.factor;
    const rect = triggerEl?.getBoundingClientRect();
    if (rect) {
        const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const gap = 0.5 * rootPx; // Tailwind mb-2
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
    if (e.key !== "Escape") return;
    close();
    triggerEl?.focus();
}

// A safety net: the sidebar is not unmounted on an SPA navigation, so the menu has to be closed explicitly.
afterNavigate(() => {
    close();
});

function focusFirstItem(node: HTMLElement) {
    queueMicrotask(() => {
        node.querySelector<HTMLElement>(".ctx-item")?.focus();
    });
}

function stepZoom(delta: number) {
    const next = zoomIndex + delta;
    if (next < 0 || next >= UI_ZOOM_LEVELS.length) return;
    const level = UI_ZOOM_LEVELS[next];
    if (level) uiZoomStore.set(level.id);
}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="relative">
    <button
        bind:this={triggerEl}
        type="button"
        onclick={toggle}
        class="btn-base btn-ghost btn-cursor-pointer inline-flex items-center justify-center gap-0.5 h-6 px-1 rounded"
        title="Settings and preferences"
        aria-label="Settings and preferences"
        aria-expanded={open}
        aria-haspopup="menu"
    >
        <Settings class="w-3 h-3" />
        <ChevronUp class="w-2.5 h-2.5" />
    </button>

    {#if open}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fixed inset-0 z-40" onclick={close} onkeydown={() => {}}></div>

        <div
            class="ctx-menu z-50 min-w-[220px]"
            class:fixed={!!pin}
            class:absolute={!pin}
            class:bottom-full={!pin}
            class:mb-2={!pin}
            class:left-0={!pin}
            use:focusFirstItem
            style={pin
                ? `left: ${pin.left}px; bottom: ${pin.bottom}px; transform: scale(${menuScale}); transform-origin: bottom left;`
                : undefined}
        >
            <a href={settingsLastTabStore.href} class="ctx-item" onclick={close}>
                <Settings class="w-[0.8125rem] h-[0.8125rem] shrink-0" /><span>Settings</span>
            </a>

            <div class="ctx-divider"></div>

            <div class="px-2.5 py-1.5 flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 text-[var(--text-dim)]">
                    <ZoomIn class="w-[0.8125rem] h-[0.8125rem]" />
                    <span class="text-xs">Zoom</span>
                </div>
                <div class="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        class="!w-6 !h-6"
                        disabled={zoomIndex <= 0}
                        onclick={() => stepZoom(-1)}
                        aria-label="Decrease zoom"
                        title="Decrease zoom"
                    >
                        <Minus class="w-3 h-3" />
                    </Button>
                    <span class="w-12 text-center tabular-nums text-2xs text-[var(--text-sub)]">
                        {UI_ZOOM_LEVELS[zoomIndex]?.label}
                    </span>
                    <Button
                        variant="ghost"
                        size="icon"
                        class="!w-6 !h-6"
                        disabled={zoomIndex >= UI_ZOOM_LEVELS.length - 1}
                        onclick={() => stepZoom(1)}
                        aria-label="Increase zoom"
                        title="Increase zoom"
                    >
                        <Plus class="w-3 h-3" />
                    </Button>
                </div>
            </div>

            <div class="ctx-divider"></div>

            <a href="/help" class="ctx-item" onclick={close}>
                <HelpCircle class="w-[0.8125rem] h-[0.8125rem] shrink-0" /><span>Help and docs</span
                >
            </a>
        </div>
    {/if}
</div>
