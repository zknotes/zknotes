<script lang="ts">
import { Check, Palette } from "lucide-svelte";
import Button from "./Button.svelte";
import { themeStore } from "$lib/core/stores/theme.svelte";
import { THEME_PRESETS } from "$lib/core/constants/theme-presets";

let open = $state(false);

function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") open = false;
}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="relative">
    <Button
        variant="ghost"
        size="icon"
        onclick={() => (open = !open)}
        class="!w-6 !h-6"
        title="Change theme"
        aria-expanded={open}
    >
        <Palette class="w-3 h-3" />
    </Button>

    {#if open}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="fixed inset-0 z-40"
            onclick={() => (open = false)}
            onkeydown={() => {}}
        ></div>

        <div class="ctx-menu absolute bottom-full mb-2 left-0 z-50 min-w-[140px]">
            {#each THEME_PRESETS as t}
                <!-- UX refactor: ctx-item stays raw (context menu pattern) -->
                <button
                    class="ctx-item w-full"
                    onclick={() => {
                        themeStore.set(t.id);
                        open = false;
                    }}
                >
                    <span
                        class="w-3.5 h-3.5 rounded-full flex-shrink-0"
                        style="background:{t.swatch}; border:1px solid {t.border}"
                    ></span>
                    <span class="flex-1 text-left">{t.label}</span>
                    {#if themeStore.current === t.id}
                        <Check class="w-3 h-3" style="color: var(--accent-color)" />
                    {/if}
                </button>
            {/each}
        </div>
    {/if}
</div>
