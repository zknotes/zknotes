<script lang="ts">
import type { Snippet } from "svelte";
import type { LucideIcon } from "$lib/core/types/icons";
import Button from "./Button.svelte";
import Checkbox from "./Checkbox.svelte";

interface Props {
    title: string;
    icon?: string | null;
    FallbackIcon?: LucideIcon;
    muted?: boolean;
    onclick?: () => void;
    selectable?: boolean;
    checked?: boolean;
    ontoggle?: (checked: boolean) => void;
    thumb?: Snippet;
    subtitle?: Snippet;
    trailing?: Snippet;
    actions?: Snippet;
}

let {
    title,
    icon = null,
    FallbackIcon,
    muted = false,
    onclick,
    selectable = false,
    checked = false,
    ontoggle,
    thumb,
    subtitle,
    trailing,
    actions,
}: Props = $props();
</script>

<div class="group flex items-center gap-3 py-2.5 px-3 border-b border-[var(--stroke)]/60 last:border-b-0 hover:bg-[var(--surface-panel)]/50 transition w-full">
    {#if selectable}
        <Checkbox {checked} onCheckedChange={ontoggle} class="flex-shrink-0" />
    {/if}
    {#if thumb}
        <div class="w-7 h-7 rounded-md overflow-hidden flex-shrink-0">
            {@render thumb()}
        </div>
    {:else}
        <div
            class="w-7 h-7 rounded-md bg-[var(--surface-raised)] flex items-center justify-center {onclick ? 'text-[var(--text-muted)]' : 'text-[var(--text-dim)]'} flex-shrink-0"
        >
            {#if icon}
                <span class="text-sm">{icon}</span>
            {:else if FallbackIcon}
                <FallbackIcon class="w-[0.8125rem] h-[0.8125rem]" />
            {/if}
        </div>
    {/if}
    {#if onclick}
        <Button
            variant="ghost"
            {onclick}
            class="flex flex-1 !justify-start gap-3 min-w-[12rem] !h-auto !px-0 hover:!bg-transparent active:!bg-transparent"
        >
            <div class="flex-1 min-w-0 text-left overflow-hidden">
                <div
                    class="text-sm font-semibold truncate {muted
                        ? 'text-[var(--text-muted)]'
                        : 'text-[var(--text)]'}"
                >
                    {title}
                </div>
                {#if subtitle}
                    <div class="min-w-0">{@render subtitle()}</div>
                {/if}
            </div>
        </Button>
    {:else}
        <div class="flex-1 min-w-[12rem] overflow-hidden">
            <div
                class="text-sm font-semibold truncate {muted
                    ? 'text-[var(--text-muted)]'
                    : 'text-[var(--text)]'}"
            >
                {title}
            </div>
            {#if subtitle}
                <div class="min-w-0">{@render subtitle()}</div>
            {/if}
        </div>
    {/if}
    {#if trailing}
        <div class="flex items-center gap-2 flex-shrink-0">
            {@render trailing()}
        </div>
    {/if}
    {#if actions}
        <div class="flex items-center gap-2 flex-shrink-0 hover-reveal">
            {@render actions()}
        </div>
    {/if}
</div>