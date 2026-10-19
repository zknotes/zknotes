<script lang="ts">
// The app-level menu: Settings / Zoom / Help. Its scope is the whole app, which is why it sits on the
// left in the sidebar footer. A self-contained trigger+popover, the same pattern as
// ThemePicker/UiZoomPicker. The theme stays in Settings → Appearance alone — it is not here, because
// the app has no submenu pattern and a row of chips proved unreadable.
//
// Zoom freeze: while the menu is open its size and position are frozen (`FrozenPopover`), so + and −
// do not jump out from under the cursor.
import { ChevronUp, HelpCircle, Minus, Plus, Settings, ZoomIn } from "lucide-svelte";
import { afterNavigate } from "$app/navigation";
import Button from "./Button.svelte";
import { uiZoomStore } from "$lib/core/stores/ui-zoom.svelte";
import { settingsLastTabStore } from "$lib/core/stores/settings-last-tab.svelte";
import { UI_ZOOM_LEVELS } from "$lib/core/constants/ui-zoom-levels";
import { FrozenPopover } from "./frozen-popover.svelte";

let triggerEl = $state<HTMLButtonElement | null>(null);
const popover = new FrozenPopover();

const zoomIndex = $derived(UI_ZOOM_LEVELS.findIndex((l) => l.id === uiZoomStore.current));

function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    popover.close();
    triggerEl?.focus();
}

// A safety net: the sidebar is not unmounted on an SPA navigation, so the menu has to be closed explicitly.
afterNavigate(popover.close);

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
        onclick={() => popover.toggle(triggerEl)}
        class="btn-base btn-ghost btn-cursor-pointer inline-flex items-center justify-center gap-0.5 h-6 px-1 rounded"
        title="Settings and preferences"
        aria-label="Settings and preferences"
        aria-expanded={popover.open}
        aria-haspopup="menu"
    >
        <Settings class="w-3 h-3" />
        <ChevronUp class="w-2.5 h-2.5" />
    </button>

    {#if popover.open}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fixed inset-0 z-40" onclick={popover.close} onkeydown={() => {}}></div>

        <div
            class="ctx-menu z-50 min-w-[220px]"
            class:fixed={!!popover.pin}
            class:absolute={!popover.pin}
            class:bottom-full={!popover.pin}
            class:mb-2={!popover.pin}
            class:left-0={!popover.pin}
            use:focusFirstItem
            style={popover.style}
        >
            <a href={settingsLastTabStore.href} class="ctx-item" onclick={popover.close}>
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

            <a href="/help" class="ctx-item" onclick={popover.close}>
                <HelpCircle class="w-[0.8125rem] h-[0.8125rem] shrink-0" /><span>Help and docs</span
                >
            </a>
        </div>
    {/if}
</div>
