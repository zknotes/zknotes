<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
    children: Snippet;
}

let { children }: Props = $props();
</script>

<!-- min-width + overflow-x: on narrow/touch screens action buttons stay visible
     (hover-reveal is always shown on touch) without crushing titles to one letter. -->
<div class="rounded-lg border border-[var(--stroke)] overflow-x-auto">
    <div class="flex flex-col min-w-[36rem]">
        {@render children()}
    </div>
</div>