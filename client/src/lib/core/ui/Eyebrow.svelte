<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
    size?: "2xs" | "xs";
    as?: string;
    class?: string;
    children: Snippet;
    [key: string]: any;
}

let { size = "2xs", as = "div", class: className = "", children, ...rest }: Props = $props();
</script>

<svelte:element this={as} class="text-{size} font-mono uppercase tracking-wider text-[var(--text-dim)] {className}" {...rest}>
    {@render children()}
</svelte:element>
