<script lang="ts">
import type { Snippet } from "svelte";
import Eyebrow from "./Eyebrow.svelte";

interface Props {
    title: string;
    eyebrow: Snippet;
    eyebrowClass?: string;
    description?: Snippet;
    actions?: Snippet;
}

let { title, eyebrow, eyebrowClass = "", description, actions }: Props = $props();
</script>

<div class="flex flex-col gap-3 mb-7 sm:flex-row sm:items-end sm:justify-between">
    <div class="min-w-0 flex-1">
        <Eyebrow class="mb-1.5 flex items-center gap-1.5 {eyebrowClass}">
            {@render eyebrow()}
        </Eyebrow>
        <h1 class="text-3xl font-bold tracking-tight text-[var(--text)]">{title}</h1>
        {#if description}
            <p class="text-[var(--text-dim)] text-sm mt-1 max-w-prose">{@render description()}</p>
        {/if}
    </div>
    {#if actions}
        <div class="flex items-center gap-2 shrink-0 flex-wrap w-full sm:w-auto">
            {@render actions()}
        </div>
    {/if}
</div>