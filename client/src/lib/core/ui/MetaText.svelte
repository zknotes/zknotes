<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
    as?: "span" | "div" | "p";
    class?: string;
    children: Snippet;
    [key: string]: any;
}

let { as = "span", class: className = "", children, ...rest }: Props = $props();
</script>

<svelte:element this={as} class="text-xs text-[var(--text-dim)] {className}" {...rest}>
    {@render children()}
</svelte:element>
